//! The Anthropic Messages API over plain HTTPS. Sections become system blocks, `tool` messages
//! become `tool_result` blocks in user messages, and `outputSchema` and `effort` go in
//! `output_config`. Empty text blocks are dropped everywhere, since the API rejects them.

use super::http::{post_json, ProviderOptions};
use super::{Provider, Request};
use crate::error::{Error, Result};
use crate::types::{AssistantMessage, Block, Message, Stop, Usage};
use async_trait::async_trait;
use serde_json::{json, Map, Value};

/// The API allows four cache breakpoints in one request.
const MAX_BREAKPOINTS: usize = 4;

pub struct Anthropic {
    options: ProviderOptions,
    http: reqwest::Client,
}

impl Anthropic {
    pub fn new(options: ProviderOptions) -> Anthropic {
        Anthropic {
            http: options.client(),
            options,
        }
    }
}

#[async_trait]
impl Provider for Anthropic {
    async fn complete(&self, request: &Request) -> Result<AssistantMessage> {
        let base = self.options.base_url.as_deref();
        let url = format!(
            "{}/v1/messages",
            base.unwrap_or("https://api.anthropic.com")
        );
        let post = self
            .http
            .post(url)
            .header("x-api-key", &self.options.api_key)
            .header("anthropic-version", "2023-06-01");
        let body = anthropic_request(request);
        let response = post_json(post, &body, request.signal.as_ref()).await?;
        from_anthropic(&response, &request.model)
    }
}

/// The request body. Public for the adapter's tests.
pub fn anthropic_request(request: &Request) -> Value {
    let ephemeral = json!({"type": "ephemeral"});
    let mut tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| json!({"name": tool.name, "description": tool.description, "input_schema": tool.input_schema}))
        .collect();
    if let Some(last) = tools.last_mut() {
        last["cache_control"] = ephemeral.clone();
    }
    // One breakpoint goes on the history, through the top-level `cache_control`, and one after
    // the tools when there are any. The earliest sections marked `cache: true` get the rest.
    let mut section_breakpoints = MAX_BREAKPOINTS - 1 - usize::from(!tools.is_empty());
    let system: Vec<Value> = request
        .sections
        .iter()
        .filter(|section| !section.text.is_empty())
        .map(|section| {
            let mut block = json!({"type": "text", "text": section.text});
            if section.cache == Some(true) && section_breakpoints > 0 {
                section_breakpoints -= 1;
                block["cache_control"] = ephemeral.clone();
            }
            block
        })
        .collect();

    let mut body = json!({
        "model": request.model,
        "max_tokens": request.max_tokens,
        "cache_control": ephemeral,
        "messages": anthropic_messages(&request.messages),
    });
    if !system.is_empty() {
        body["system"] = Value::Array(system);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    let mut output_config = Map::new();
    if let Some(schema) = &request.output_schema {
        output_config.insert(
            "format".into(),
            json!({"type": "json_schema", "schema": schema}),
        );
    }
    if let Some(effort) = &request.effort {
        output_config.insert("effort".into(), json!(effort));
    }
    if !output_config.is_empty() {
        body["output_config"] = Value::Object(output_config);
    }
    body
}

/// flatbed's messages as the API's alternating user and assistant messages. Tool results move
/// into user messages, ahead of anything else there, since the API wants them first.
fn anthropic_messages(messages: &[Message]) -> Vec<Value> {
    let mut out: Vec<(&str, Vec<Value>)> = Vec::new();
    for message in messages {
        let (role, content): (&str, Vec<Value>) = match message {
            Message::User(user) => ("user", user.content.iter().filter_map(api_block).collect()),
            Message::Tool(result) => {
                let mut content: Vec<Value> = result.content.iter().filter_map(api_block).collect();
                if content.is_empty() {
                    content.push(json!({"type": "text", "text": "(no output)"}));
                }
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": result.call_id,
                    "content": content,
                    "is_error": result.is_error,
                });
                ("user", vec![block])
            }
            Message::Assistant(assistant) => (
                "assistant",
                assistant
                    .content
                    .iter()
                    .filter_map(api_assistant_block)
                    .collect(),
            ),
        };
        // A message left empty, such as the assistant message a failed call leaves, has nothing
        // to send.
        if content.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some((last_role, blocks)) if *last_role == role => blocks.extend(content),
            _ => out.push((role, content)),
        }
    }
    for (_, blocks) in &mut out {
        // A stable sort keeps the order within tool results and within the rest.
        blocks.sort_by_key(|block| block["type"] != "tool_result");
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
            let mut block = json!({"type": "thinking", "thinking": text});
            if let Some(signature) = signature {
                block["signature"] = json!(signature);
            }
            block
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
                // A missing signature is left out, never stored as an empty string.
                signature: block["signature"].as_str().map(String::from),
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
