//! The types flatbed holds: sessions and their entries, and messages in flatbed's own format.
//! Their JSON shapes are the contract in docs/spec/sessions.md, so serde derives them field for
//! field. Data that only passes through, such as tool input or a plugin's custom state, stays a
//! `serde_json::Value`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

// Content blocks and messages.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Text {
        text: String,
    },
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        data: String,
    },
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
    },
    ToolCall(ToolCall),
}

impl Block {
    pub fn text(text: impl Into<String>) -> Block {
        Block::Text { text: text.into() }
    }
}

/// A call the model makes. `input` is whatever the model sent, which the loop checks against the
/// tool's schema before the tool sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
}

impl Usage {
    /// The size the budget counts: everything the model read and wrote on its last call.
    pub fn size(&self) -> u64 {
        self.input + self.output + self.cache_read.unwrap_or(0) + self.cache_write.unwrap_or(0)
    }
}

/// Why the model stopped. (The stop signal, which stops a run, is `StopSignal` in the loop.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stop {
    End,
    ToolUse,
    MaxTokens,
    Refusal,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum Message {
    User(UserMessage),
    Assistant(AssistantMessage),
    Tool(ToolMessage),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UserMessage {
    pub content: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub content: Vec<Block>,
    /// `<provider>/<model-name>`, such as `anthropic/claude-opus-5-5`.
    pub model: String,
    pub usage: Usage,
    pub stop: Stop,
}

impl AssistantMessage {
    pub fn tool_calls(&self) -> impl Iterator<Item = &ToolCall> {
        self.content.iter().filter_map(|block| match block {
            Block::ToolCall(call) => Some(call),
            _ => None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMessage {
    pub call_id: String,
    pub name: String,
    pub content: Vec<Block>,
    pub is_error: bool,
}

// Sessions.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Section {
    pub name: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Something from outside the agent, for the model to see.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attrs: Option<BTreeMap<String, String>>,
    pub text: String,
}

impl Event {
    /// A notice from the harness to the agent.
    pub fn notice(text: impl Into<String>) -> Event {
        let attrs = BTreeMap::from([("from".to_string(), "harness".to_string())]);
        Event {
            kind: "notice".into(),
            attrs: Some(attrs),
            text: text.into(),
        }
    }
}

/// The first line of a session file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename = "session", rename_all = "camelCase")]
pub struct Header {
    pub version: u32,
    pub id: String,
    pub agent: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<ParentLink>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ParentLink {
    pub session: String,
    /// `reset`, `fork`, `dispatch` or `supervise`.
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    /// The parent session's agent, when it is another agent's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

/// Every line of a session after the header.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    pub at: String,
    #[serde(flatten)]
    pub body: EntryBody,
}

/// An entry without its place in the log: what a caller asks the loop to append.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EntryBody {
    Context {
        sections: Vec<Section>,
        tools: Vec<ToolDefinition>,
    },
    Message {
        message: Message,
    },
    Event(Event),
    Reset {
        /// `agent` or `harness`.
        by: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Custom {
        plugin: String,
        data: Value,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub header: Header,
    pub entries: Vec<Entry>,
}
