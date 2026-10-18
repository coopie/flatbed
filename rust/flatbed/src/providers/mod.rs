//! Providers turn flatbed's context and messages into one API's request, and the response back
//! into an assistant message, as docs/spec/providers.md describes.

pub mod anthropic;
pub mod faux;
mod http;
pub mod openai;

pub use http::ProviderOptions;

use crate::error::Result;
use crate::stop::StopSignal;
use crate::types::{AssistantMessage, Message, Section, ToolDefinition};
use async_trait::async_trait;
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Request {
    /// The model name, without the provider prefix.
    pub model: String,
    pub sections: Vec<Section>,
    pub tools: Vec<ToolDefinition>,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
    /// A JSON Schema the response's text must match, for structured output. The loop never sets
    /// it; callers that use a provider directly do.
    pub output_schema: Option<Value>,
    /// How much effort the model should spend, such as `low` or `high`, for providers that take it.
    pub effort: Option<String>,
    /// Cancels the request, and any backoff wait between tries.
    pub signal: Option<StopSignal>,
}

#[async_trait]
pub trait Provider: Send + Sync {
    async fn complete(&self, request: &Request) -> Result<AssistantMessage>;
}
