//! Providers turn flatbed's context and messages into one API's request, and the response back
//! into an assistant message, as docs/spec/providers.md describes.

pub mod anthropic;
pub mod faux;

use crate::agent::StopSignal;
use crate::error::Result;
use crate::types::{AssistantMessage, Message, Section, ToolDefinition};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Request {
    /// The model name, without the provider prefix.
    pub model: String,
    pub sections: Vec<Section>,
    pub tools: Vec<ToolDefinition>,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
    /// A JSON Schema the response's text must match, for structured output.
    pub output_schema: Option<Value>,
    /// How much effort the model should spend, such as `low` or `high`, for providers that take it.
    pub effort: Option<String>,
    /// Checked between attempts. A blocking request cannot be cancelled once sent.
    pub signal: Option<StopSignal>,
}

pub trait Provider {
    fn complete(&self, request: &Request) -> Result<AssistantMessage>;
}
