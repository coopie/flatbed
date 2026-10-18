//! Any chat-completions-compatible endpoint over plain HTTPS. Sections are joined into one system
//! message, and thinking blocks are dropped, since the format has no place for them.

use super::http::{post_json, ProviderOptions};
use super::{Provider, Request};
use crate::error::{Error, Result};
use crate::types::{AssistantMessage, Block, Message, Stop, ToolCall, Usage};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct OpenAi {
    options: ProviderOptions,
    http: reqwest::Client,
}

impl OpenAi {
    pub fn new(options: ProviderOptions) -> OpenAi {
        OpenAi {
            http: options.client(),
            options,
        }
    }
}

#[async_trait]
impl Provider for OpenAi {
    async fn complete(&self, request: &Request) -> Result<AssistantMessage> {
        let base = self.options.base_url.as_deref();
        let url = format!(
            "{}/chat/completions",
            base.unwrap_or("https://api.openai.com/v1")
        );
        let post = self.http.post(url).bearer_auth(&self.options.api_key);
        let response = post_json(post, &openai_request(request), request.signal.as_ref()).await?;
        from_openai(&response, &request.model)
    }
}

/// The request body. Public for the adapter's tests.
pub fn openai_request(request: &Request) -> Value {
    let system: Vec<&str> = request.sections.iter().map(|s| s.text.as_str()).collect();
    let system = system.join("\n\n");
    let mut messages = Vec::new();
    if !system.is_empty() {
        messages.push(json!({"role": "system", "content": system}));
    }
    messages.extend(request.messages.iter().filter_map(openai_message));
    let mut body = json!({
        "model": request.model,
        "max_tokens": request.max_tokens,
        "messages": messages,
    });
    let tools: Vec<Value> = request
        .tools
        .iter()
        .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}}))
        .collect();
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    if let Some(effort) = &request.effort {
        body["reasoning_effort"] = json!(effort);
    }
    if let Some(schema) = &request.output_schema {
        body["response_format"] = json!({"type": "json_schema", "json_schema": {"name": "output", "schema": schema, "strict": true}});
    }
    body
}

fn openai_message(message: &Message) -> Option<Value> {
    match message {
        Message::User(user) => {
            let parts: Vec<Value> = user.content.iter().filter_map(part).collect();
            Some(json!({"role": "user", "content": parts}))
        }
        Message::Tool(result) => {
            // Tool messages take text only, so an image in a result is described, not sent.
            let text: Vec<String> = result
                .content
                .iter()
                .filter_map(|block| match block {
                    Block::Text { text } => Some(text.clone()),
                    Block::Image { mime_type, .. } => Some(format!("[image {mime_type}]")),
                    _ => None,
                })
                .collect();
            let text = text.join("\n");
            let content = if result.is_error {
                format!("Error: {text}")
            } else {
                text
            };
            Some(json!({"role": "tool", "tool_call_id": result.call_id, "content": content}))
        }
        Message::Assistant(assistant) => {
            let text: String = assistant
                .content
                .iter()
                .filter_map(|block| match block {
                    Block::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            let calls: Vec<Value> = assistant
                .tool_calls()
                .map(|call| json!({"id": call.id, "type": "function", "function": {"name": call.name, "arguments": call.input.to_string()}}))
                .collect();
            if text.is_empty() && calls.is_empty() {
                return None;
            }
            let mut out = json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }});
            if !calls.is_empty() {
                out["tool_calls"] = Value::Array(calls);
            }
            Some(out)
        }
    }
}

fn part(block: &Block) -> Option<Value> {
    match block {
        Block::Text { text } => Some(json!({"type": "text", "text": text})),
        Block::Image { mime_type, data } => Some(
            json!({"type": "image_url", "image_url": {"url": format!("data:{mime_type};base64,{data}")}}),
        ),
        _ => None,
    }
}

/// The assistant message for a response. Public for the adapter's tests.
pub fn from_openai(response: &Value, model: &str) -> Result<AssistantMessage> {
    let Some(choice) = response["choices"].get(0) else {
        return Err(Error::new("The response had no choices."));
    };
    let message = &choice["message"];
    let mut content = Vec::new();
    if let Some(text) = message["content"].as_str().filter(|t| !t.is_empty()) {
        content.push(Block::text(text));
    }
    for call in message["tool_calls"].as_array().into_iter().flatten() {
        let function = &call["function"];
        let arguments = function["arguments"].as_str().filter(|a| !a.is_empty());
        // Input that is not JSON fails the call, which the loop records as a failed model call.
        let input = serde_json::from_str(arguments.unwrap_or("{}"))?;
        content.push(Block::ToolCall(ToolCall {
            id: call["id"].as_str().unwrap_or_default().into(),
            name: function["name"].as_str().unwrap_or_default().into(),
            input,
        }));
    }
    let stop = match choice["finish_reason"].as_str() {
        Some("tool_calls") => Stop::ToolUse,
        Some("length") => Stop::MaxTokens,
        Some("content_filter") => Stop::Refusal,
        _ => Stop::End,
    };
    let usage = &response["usage"];
    let cached = usage["prompt_tokens_details"]["cached_tokens"]
        .as_u64()
        .filter(|&n| n > 0);
    Ok(AssistantMessage {
        content,
        model: format!("openai/{model}"),
        usage: Usage {
            // OpenAI counts cached tokens inside prompt_tokens; flatbed counts them apart.
            input: usage["prompt_tokens"]
                .as_u64()
                .unwrap_or(0)
                .saturating_sub(cached.unwrap_or(0)),
            output: usage["completion_tokens"].as_u64().unwrap_or(0),
            cache_read: cached,
            cache_write: None,
        },
        stop,
    })
}
