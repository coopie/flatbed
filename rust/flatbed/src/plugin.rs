//! Plugins and tools, as docs/spec/plugins.md describes. A plugin is a trait object with a name
//! and up to five hooks, each with a default that does nothing. A tool is a definition and a
//! function. Both see a `Ctx`, through which they add to the session or queue events.

use crate::agent::{AgentConfig, StopSignal};
use crate::error::{Error, Result};
use crate::types::{Block, Entry, EntryBody, Event, Section, Session, ToolCall, ToolDefinition};
use serde_json::{Map, Value};

pub trait Plugin {
    fn name(&self) -> &str;

    /// When a session opens: sections and tools to add.
    fn context(&self, _ctx: &mut Ctx) -> Result<Contribution> {
        Ok(Contribution::default())
    }

    /// Before a tool call runs: a result to use instead of running it, or `None` to let it run.
    /// An error here, or in `after_tool`, gives the call the error result
    /// `The <plugin> plugin failed: <message>`, and no later hook runs for it.
    fn before_tool(&self, _call: &ToolCall, _ctx: &mut Ctx) -> Result<Option<ToolResult>> {
        Ok(None)
    }

    /// After a tool call runs or is replaced: the result, changed or as it was.
    fn after_tool(
        &self,
        _call: &ToolCall,
        result: ToolResult,
        _ctx: &mut Ctx,
    ) -> Result<ToolResult> {
        Ok(result)
    }

    /// After every entry is appended, for watching.
    fn on_entry(&self, _entry: &Entry, _ctx: &mut Ctx) {}

    /// After a `reset` is appended. `ctx.append` fails here; use `ctx.deliver`.
    fn on_session_end(&self, _session: &Session, _ctx: &mut Ctx) {}
}

/// What a plugin's `context` hook adds to a session.
#[derive(Default)]
pub struct Contribution {
    pub sections: Vec<Section>,
    pub tools: Vec<Box<dyn Tool>>,
}

pub trait Tool {
    fn definition(&self) -> ToolDefinition;

    /// Runs the call. The loop has already checked `input` against the schema. An error becomes
    /// an error result carrying its message.
    fn run(&self, input: &Map<String, Value>, ctx: &mut Ctx) -> Result<ToolResult>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolResult {
    pub content: Vec<Block>,
    pub is_error: bool,
}

impl ToolResult {
    pub fn text(text: impl Into<String>) -> ToolResult {
        ToolResult {
            content: vec![Block::text(text)],
            is_error: false,
        }
    }

    pub fn error(text: impl Into<String>) -> ToolResult {
        ToolResult {
            content: vec![Block::text(text)],
            is_error: true,
        }
    }
}

/// A tool made from a definition and a closure, for tools that need no state of their own.
pub struct FnTool<F> {
    pub definition: ToolDefinition,
    pub run: F,
}

impl<F> Tool for FnTool<F>
where
    F: Fn(&Map<String, Value>, &mut Ctx) -> Result<ToolResult>,
{
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn run(&self, input: &Map<String, Value>, ctx: &mut Ctx) -> Result<ToolResult> {
        (self.run)(input, ctx)
    }
}

/// What a hook or a tool can see and do. It sees the agent and the open session as they were
/// when the hook was called. What it appends or delivers is collected here, and the loop writes
/// it as soon as the hook returns, so a hook never holds the session while it changes.
pub struct Ctx<'a> {
    pub agent: &'a AgentConfig,
    pub session: &'a Session,
    /// The run's stop signal, so that a long tool can stop when the run is stopped. It is never
    /// set when the host gave none.
    pub signal: StopSignal,
    pub(crate) outputs: Outputs,
    ended: bool,
}

#[derive(Default)]
pub(crate) struct Outputs {
    pub appended: Vec<EntryBody>,
    pub delivered: Vec<Event>,
    /// Set when a tool asked for a reset, with the reason it gave.
    pub reset: Option<Option<String>>,
}

impl Outputs {
    pub fn merge(&mut self, other: Outputs) {
        self.appended.extend(other.appended);
        self.delivered.extend(other.delivered);
        if self.reset.is_none() {
            self.reset = other.reset;
        }
    }
}

impl<'a> Ctx<'a> {
    pub(crate) fn new(agent: &'a AgentConfig, session: &'a Session) -> Ctx<'a> {
        Ctx {
            agent,
            session,
            signal: StopSignal::new(),
            outputs: Outputs::default(),
            ended: false,
        }
    }

    /// A context for `on_session_end`, where nothing can be appended.
    pub(crate) fn ended(agent: &'a AgentConfig, session: &'a Session) -> Ctx<'a> {
        Ctx {
            ended: true,
            ..Ctx::new(agent, session)
        }
    }

    /// Adds a `custom` entry, the plugin's own state, to the open session. Events go through
    /// `deliver`, so the loop decides where they land.
    pub fn append(&mut self, plugin: &str, data: Value) -> Result<()> {
        if self.ended {
            return Err(Error::new(
                "The session has ended, so nothing can be appended. Use deliver instead.",
            ));
        }
        self.outputs.appended.push(EntryBody::Custom {
            plugin: plugin.to_string(),
            data,
        });
        Ok(())
    }

    /// Queues an event for the next delivery point.
    pub fn deliver(&mut self, event: Event) {
        self.outputs.delivered.push(event);
    }

    /// Asks the loop to end the session after this turn. For tools; the core `reset` tool uses it.
    /// An empty reason counts as none.
    pub fn request_reset(&mut self, reason: Option<String>) {
        let reason = reason.filter(|r| !r.is_empty());
        self.outputs.reset.get_or_insert(reason);
    }
}
