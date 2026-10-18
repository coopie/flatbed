//! Plugins and tools, as docs/spec/plugins.md describes. A plugin is a trait object with a name
//! and up to five async hooks, each with a default that does nothing. A tool is a definition and
//! an async function. Both see a `Ctx`, through which they add to the session or queue events.
//!
//! The traits use `async_trait`, which boxes each call's future, so that a plugin or tool can be
//! a trait object and still be written as plain `async fn`s with defaults. Writing the boxed
//! futures by hand would put a `Pin<Box<dyn Future>>` in every signature a plugin author reads.

use crate::agent::{AgentConfig, Place, Run, Turn};
use crate::error::{Error, Result};
use crate::stop::StopSignal;
use crate::types::{Block, Entry, EntryBody, Event, Section, Session, ToolCall, ToolDefinition};
use async_trait::async_trait;
use serde_json::{Map, Value};
use std::future::Future;
use std::sync::Arc;

#[async_trait]
pub trait Plugin: Send + Sync {
    fn name(&self) -> &str;

    /// When a session opens: sections and tools to add. `ctx.append` fails here, since the
    /// session's first entry must be its `context` entry. An error fails the run, before anything
    /// is written, with `The <plugin> plugin failed: <message>`.
    async fn context(&self, _ctx: &Ctx) -> Result<Contribution> {
        Ok(Contribution::default())
    }

    /// Before a tool call runs: a result to use instead of running it, or `None` to let it run.
    /// An error here, or in `after_tool`, gives the call the error result
    /// `The <plugin> plugin failed: <message>`, and no later hook runs for it.
    async fn before_tool(&self, _call: &ToolCall, _ctx: &Ctx) -> Result<Option<ToolResult>> {
        Ok(None)
    }

    /// After a tool call runs or is replaced: the result, changed or as it was.
    async fn after_tool(
        &self,
        _call: &ToolCall,
        result: ToolResult,
        _ctx: &Ctx,
    ) -> Result<ToolResult> {
        Ok(result)
    }

    /// After every entry is appended, for watching. It cannot fail, so that a watcher can never
    /// leave a turn's results half written.
    async fn on_entry(&self, _entry: &Entry, _ctx: &Ctx) {}

    /// After a `reset` is appended. It cannot fail, since the session has already ended.
    /// `ctx.append` fails here; use `ctx.deliver`.
    async fn on_session_end(&self, _session: &Session, _ctx: &Ctx) {}
}

/// What a plugin's `context` hook adds to a session.
#[derive(Default)]
pub struct Contribution {
    pub sections: Vec<Section>,
    pub tools: Vec<Box<dyn Tool>>,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn definition(&self) -> ToolDefinition;

    /// Runs the call. The loop has already checked `input` against the schema. An error becomes
    /// an error result carrying its message. A long tool can race its work against
    /// `ctx.signal().wait()` to finish early when the run is stopped.
    async fn run(&self, input: &Map<String, Value>, ctx: &Ctx) -> Result<ToolResult>;
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

/// A tool made from a definition and an async closure, for tools that need no state of their own.
/// The closure gets its own copies of the input and the context, so its future can outlive the call.
pub struct FnTool<F> {
    pub definition: ToolDefinition,
    pub run: F,
}

#[async_trait]
impl<F, Fut> Tool for FnTool<F>
where
    F: Fn(Map<String, Value>, Ctx) -> Fut + Send + Sync,
    Fut: Future<Output = Result<ToolResult>> + Send,
{
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    async fn run(&self, input: &Map<String, Value>, ctx: &Ctx) -> Result<ToolResult> {
        (self.run)(input.clone(), ctx.clone()).await
    }
}

/// What a hook or a tool can see and do: the agent, the open session, the run's stop signal, and
/// actions that write to the session or queue events at once. It is cheap to clone.
#[derive(Clone)]
pub struct Ctx {
    run: Arc<Run>,
    /// Why `append` fails, when it does: while a session opens, and after it ends.
    refuse_append: Option<&'static str>,
    /// The index of the call this context is for, when it is for a tool call, so that the first
    /// reset in call order wins. A call a tool makes with `run_tool` shares its caller's index.
    call: Option<usize>,
    /// For a tool call: the turn it runs in and its place under the turn's limit, for `run_tool`.
    turn: Option<(Arc<Turn>, Arc<Place>)>,
}

impl Ctx {
    pub(crate) fn new(run: Arc<Run>) -> Ctx {
        Ctx {
            run,
            refuse_append: None,
            call: None,
            turn: None,
        }
    }

    /// A context for a call of the turn's call at `index`, holding `place` under the turn's limit.
    pub(crate) fn for_call(run: Arc<Run>, index: usize, turn: Arc<Turn>, place: Arc<Place>) -> Ctx {
        Ctx {
            call: Some(index),
            turn: Some((turn, place)),
            ..Ctx::new(run)
        }
    }

    /// A context for the `context` hook, where nothing can be appended yet.
    pub(crate) fn opening(run: Arc<Run>) -> Ctx {
        Ctx {
            refuse_append: Some("The session is opening, so nothing can be appended yet."),
            ..Ctx::new(run)
        }
    }

    /// A context for `on_session_end`, where nothing can be appended.
    pub(crate) fn ended(run: Arc<Run>) -> Ctx {
        Ctx {
            refuse_append: Some(
                "The session has ended, so nothing can be appended. Use deliver instead.",
            ),
            ..Ctx::new(run)
        }
    }

    pub fn agent(&self) -> &AgentConfig {
        &self.run.agent
    }

    /// The open session as it is now, including what other calls of this turn have appended.
    pub async fn session(&self) -> Session {
        self.run.session.lock().await.clone()
    }

    /// The run's stop signal, so that a long tool can stop when the run is stopped. It is never
    /// set when the host gave none.
    pub fn signal(&self) -> &StopSignal {
        &self.run.stop
    }

    /// Adds a `custom` entry, the plugin's own state, to the open session, and returns once it is
    /// written. Events go through `deliver`, so the loop decides where they land.
    pub async fn append(&self, plugin: &str, data: Value) -> Result<()> {
        if let Some(refusal) = self.refuse_append {
            return Err(Error::new(refusal));
        }
        let body = EntryBody::Custom {
            plugin: plugin.to_string(),
            data,
        };
        self.run.append(body, None).await
    }

    /// Queues an event for the next delivery point.
    pub fn deliver(&self, event: Event) {
        self.run.queue(event, None);
    }

    /// Runs another call as the loop runs the model's calls, through the same hooks and under the
    /// turn's limit, and returns its result without appending a `tool` message. The calling tool
    /// gives up its place under the limit while it waits. Only a tool's context can run calls.
    pub async fn run_tool(&self, call: ToolCall) -> ToolResult {
        let Some((turn, place)) = &self.turn else {
            return ToolResult::error("Only a tool's context can run other tools.");
        };
        place.give_up().await;
        let index = self.call.unwrap_or(usize::MAX);
        let result = Box::pin(turn.run_limited(&call, index)).await;
        place.take_back().await;
        result
    }

    /// Asks the loop to end the session after this turn. For tools; the core `reset` tool uses it.
    /// The first request in call order wins, and an empty reason counts as none.
    pub fn request_reset(&self, reason: Option<String>) {
        let call = self.call.unwrap_or(usize::MAX);
        self.run
            .request_reset(call, reason.filter(|r| !r.is_empty()));
    }
}
