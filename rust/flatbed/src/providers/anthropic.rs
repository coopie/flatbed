//! The Anthropic Messages API over plain HTTPS. Sections become system blocks, `tool` messages
//! become `tool_result` blocks in user messages, and `outputSchema` becomes
//! `output_config.format`.

use super::{Provider, Request};
use crate::error::{Error, Result};
use crate::types::{AssistantMessage, Block, Message, Stop, Usage};
use serde_json::{json, Map, Value};
use std::time::Duration;

const RETRIES: u32 = 3;
/// The API allows four cache breakpoints in one request.
const MAX_BREAKPOINTS: usize = 4;

pub struct Anthropic {
    api_key: String,
    url: String,
    http: ureq::Agent,
}

impl Anthropic {
    pub fn new(api_key: impl Into<String>) -> Anthropic {
        Anthropic::with_base_url(api_key, "https://api.anthropic.com")
    }

    pub fn with_base_url(api_key: impl Into<String>, base_url: &str) -> Anthropic {
        Anthropic {
            api_key: api_key.into(),
            url: format!("{base_url}/v1/messages"),
            http: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(600))
                .build(),
        }
    }

    /// POSTs the body, retrying rate limits, server errors and network failures three times with
    /// backoff. A client error, or a stop signal set between attempts, is final.
    fn post(&self, body: &Value, request: &Request) -> Result<Value> {
        let mut attempt = 0;
        loop {
            let failure = match self
                .http
                .post(&self.url)
                .set("x-api-key", &self.api_key)
                .set("anthropic-version", "2023-06-01")
                .set("content-type", "application/json")
                .send_string(&body.to_string())
            {
                Ok(response) => return Ok(serde_json::from_str(&response.into_string()?)?),
                Err(ureq::Error::Status(status, response)) => {
                    let text: String = response.into_string().unwrap_or_default();
                    let failure = format!("HTTP {status}: {}", truncate(&text, 500));
                    if status != 429 && status < 500 {
                        return Err(Error(failure));
                    }
                    failure
                }
                Err(ureq::Error::Transport(transport)) => transport.to_string(),
            };
            let stopped = request.signal.as_ref().and_then(|s| s.stopped_by());
            if attempt == RETRIES || stopped.is_some() {
                return Err(Error(format!("{failure} (after {attempt} retries)")));
            }
            std::thread::sleep(Duration::from_secs(1 << attempt));
            attempt += 1;
        }
    }
}

impl Provider for Anthropic {
    fn complete(&self, request: &Request) -> Result<AssistantMessage> {
        let response = self.post(&anthropic_request(request), request)?;
        from_anthropic(&response, &request.model)
    }
}

fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

/// The request body. Public for the adapter's tests.
pub fn anthropic_request(request: &Request) -> Value {
    let mut system: Vec<Value> = request
        .sections
        .iter()
        .map(|section| json!({"type": "text", "text": section.text}))
        .collect();
    let mut tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| json!({"name": tool.name, "description": tool.description, "input_schema": tool.input_schema}))
        .collect();

    // Breakpoints go after the tool list and after each cached section. The API reads tools
    // before the system prompt, so when there are more than four, the earliest are dropped.
    let mut breakpoints: Vec<&mut Value> = Vec::new();
    if let Some(last) = tools.last_mut() {
        breakpoints.push(last);
    }
    for (block, section) in system.iter_mut().zip(&request.sections) {
        if section.cache == Some(true) {
            breakpoints.push(block);
        }
    }
    let skip = breakpoints.len().saturating_sub(MAX_BREAKPOINTS);
    for block in breakpoints.into_iter().skip(skip) {
        block["cache_control"] = json!({"type": "ephemeral"});
    }

    let mut body = json!({
        "model": request.model,
        "max_tokens": request.max_tokens,
        "system": system,
        "messages": anthropic_messages(&request.messages),
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    if let Some(schema) = &request.output_schema {
        body["output_config"] = json!({"format": {"type": "json_schema", "schema": schema}});
    }
    body
}

/// flatbed's messages as the API's alternating user and assistant messages. Tool results move
/// into user messages, ahead of any text there, since the API wants them first.
fn anthropic_messages(messages: &[Message]) -> Vec<Value> {
    let mut out: Vec<(&str, Vec<Value>)> = Vec::new();
    for message in messages {
        let (role, content, first) = match message {
            Message::User(user) => (
                "user",
                user.content.iter().filter_map(api_block).collect(),
                false,
            ),
            Message::Tool(result) => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": result.call_id,
                    "content": result.content.iter().filter_map(api_block).collect::<Vec<_>>(),
                    "is_error": result.is_error,
                });
                ("user", vec![block], true)
            }
            Message::Assistant(assistant) => (
                "assistant",
                assistant
                    .content
                    .iter()
                    .filter_map(api_assistant_block)
                    .collect(),
                false,
            ),
        };
        // An assistant message left empty by a failed call has nothing to send.
        if content.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some((last_role, blocks)) if *last_role == role => {
                if first {
                    let at = blocks
                        .iter()
                        .take_while(|b| b["type"] == "tool_result")
                        .count();
                    blocks.splice(at..at, content);
                } else {
                    blocks.extend(content);
                }
            }
            _ => out.push((role, content)),
        }
    }
    out.into_iter()
        .map(|(role, content)| json!({"role": role, "content": content}))
        .collect()
}

/// A text or image block. The API rejects empty text, so it is dropped.
fn api_block(block: &Block) -> Option<Value> {
    match block {
        Block::Text { text } if text.is_empty() => None,
        Block::Text { text } => Some(json!({"type": "text", "text": text})),
        Block::Image { mime_type, data } => Some(json!({
            "type": "image",
            "source": {"type": "base64", "media_type": mime_type, "data": data},
        })),
        _ => None,
    }
}

fn api_assistant_block(block: &Block) -> Option<Value> {
    match block {
        Block::ToolCall(call) => {
            Some(json!({"type": "tool_use", "id": call.id, "name": call.name, "input": call.input}))
        }
        // Thinking goes back only to the provider that made it.
        Block::Thinking {
            text,
            signature,
            provider,
        } => (provider.as_deref() == Some("anthropic")).then(|| {
            json!({"type": "thinking", "thinking": text, "signature": signature.clone().unwrap_or_default()})
        }),
        other => api_block(other),
    }
}

/// The assistant message for a response. Public for the adapter's tests.
pub fn from_anthropic(response: &Value, model: &str) -> Result<AssistantMessage> {
    let (Some(blocks), Some(usage)) = (response["content"].as_array(), response.get("usage"))
    else {
        return Err(Error::new(
            "The Anthropic response had no content or usage.",
        ));
    };
    let text = |value: &Value| value.as_str().unwrap_or_default().to_string();
    let content = blocks
        .iter()
        .filter_map(|block| match block["type"].as_str() {
            Some("text") => Some(Block::text(text(&block["text"]))),
            Some("tool_use") => Some(Block::ToolCall(crate::types::ToolCall {
                id: text(&block["id"]),
                name: text(&block["name"]),
                input: block
                    .get("input")
                    .cloned()
                    .unwrap_or(Value::Object(Map::new())),
            })),
            Some("thinking") => Some(Block::Thinking {
                text: text(&block["thinking"]),
                signature: Some(text(&block["signature"])),
                provider: Some("anthropic".into()),
            }),
            _ => None,
        })
        .collect();
    let stop = match response["stop_reason"].as_str() {
        Some("tool_use") => Stop::ToolUse,
        Some("max_tokens") => Stop::MaxTokens,
        Some("refusal") => Stop::Refusal,
        _ => Stop::End,
    };
    Ok(AssistantMessage {
        content,
        model: format!("anthropic/{model}"),
        usage: Usage {
            input: usage["input_tokens"].as_u64().unwrap_or(0),
            output: usage["output_tokens"].as_u64().unwrap_or(0),
            cache_read: usage["cache_read_input_tokens"].as_u64(),
            cache_write: usage["cache_creation_input_tokens"].as_u64(),
        },
        stop,
    })
}
