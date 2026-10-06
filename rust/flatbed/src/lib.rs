//! flatbed, a very small agent harness. Read it top to bottom in this order:
//!
//! 1. `types`: sessions, entries and messages, in the shapes docs/spec/sessions.md fixes
//! 2. `store`: where sessions live, as files or in memory
//! 3. `render`: the path through a session, and the messages the model sees
//! 4. `plugin`: plugins, tools and the context their hooks get
//! 5. `agent`: the loop itself
//! 6. `providers`: the scripted fake and Anthropic
//!
//! `ids` and `env` are small helpers. The spec in docs/spec/ is the contract this follows.

pub mod agent;
pub mod env;
pub mod error;
pub mod ids;
pub mod plugin;
pub mod providers;
pub mod render;
pub mod store;
pub mod types;

pub use agent::{Agent, AgentConfig, Outcome, StopSignal};
pub use error::{Error, Result};
pub use plugin::{Contribution, Ctx, FnTool, Plugin, Tool, ToolResult};
pub use providers::{Provider, Request};
pub use store::{FileStore, MemoryStore, Store};
pub use types::*;
