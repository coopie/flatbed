//! The loop, as docs/spec/loop.md describes: open a session if none is open, repair it, deliver
//! waiting events, then ask the model and run its tools until nothing new needs an answer.
//! `Agent::run` is the whole harness; `Run` holds one run's view of the open session, and every
//! other function here is one step of it.

use crate::error::{Error, Result};
use crate::ids::{new_entry_id, new_session_id, now_iso};
use crate::plugin::{Contribution, Ctx, Plugin, Tool, ToolResult};
use crate::providers::{Provider, Request};
use crate::render::{path_of, render, Context};
use crate::stop::StopSignal;
use crate::store::Store;
use crate::types::{
    AssistantMessage, Entry, EntryBody, Event, Header, Message, ParentLink, Session, Stop,
    ToolCall, ToolDefinition, ToolMessage, Usage,
};
use async_trait::async_trait;
use futures_util::future::{join_all, BoxFuture};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const SOFT_LIMIT_NOTICE: &str =
    "This session is nearly full. Bring your notes up to date, then call reset.";
const REPAIR_TEXT: &str = "The harness stopped before this tool ran.";
const CUT_OFF_TEXT: &str = "The response was cut off before this call was complete.";
const RESET_RESULT: &str = "Session will reset after this turn.";
const RESET_DESCRIPTION: &str = "End this session and start a fresh one. Call it when your notes are up to date and the session is long, or when the work is finished. Anything not written down will be forgotten.";

/// An agent as the host configures it, as docs/spec/host.md describes. The core stores nothing
/// about it beyond its sessions.
pub struct AgentConfig {
    pub id: String,
    /// `<provider>/<model-name>`, such as `anthropic/claude-opus-5-5` or `faux/test`.
    pub model: String,
    pub plugins: Vec<Box<dyn Plugin>>,
    pub soft_limit: u64,
    pub hard_limit: u64,
    pub max_tokens: u32,
    /// Passed to providers that take it, such as `low` or `high`.
    pub effort: Option<String>,
    pub tool_execution: ToolExecution,
    /// The most calls that run at once when concurrent. At least 1.
    pub max_concurrent_tools: usize,
    /// The parent of the agent's first session, such as the session that dispatched it.
    pub parent: Option<ParentLink>,
}

impl AgentConfig {
    pub fn new(id: impl Into<String>, model: impl Into<String>) -> AgentConfig {
        AgentConfig {
            id: id.into(),
            model: model.into(),
            plugins: Vec::new(),
            soft_limit: 120_000,
            hard_limit: 180_000,
            max_tokens: 8_192,
            effort: None,
            tool_execution: ToolExecution::Concurrent,
            max_concurrent_tools: 4,
            parent: None,
        }
    }
}

/// How a turn's tool calls run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToolExecution {
    /// Calls start in call order, at most `max_concurrent_tools` at once.
    #[default]
    Concurrent,
    /// Each call starts only after the one before it has finished.
    Serial,
}

/// Why a run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Idle,
    Reset,
    Stopped,
    Error,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Idle => "idle",
            Outcome::Reset => "reset",
            Outcome::Stopped => "stopped",
            Outcome::Error => "error",
        }
    }
}

/// An event waiting for the next delivery point, with the entry to follow when rewinding.
struct Queued {
    event: Event,
    parent: Option<String>,
}

type Queue = Arc<Mutex<Vec<Queued>>>;
type Tools = Arc<Vec<Box<dyn Tool>>>;

pub struct Agent {
    config: Arc<AgentConfig>,
    store: Arc<dyn Store>,
    provider: Arc<dyn Provider>,
    /// The model name without its provider, as providers take it.
    model: String,
    queue: Queue,
    /// The tools' code for the open session, by session id, kept between runs. The session's
    /// `context` entry says which tools exist; the plugins supply their code.
    tools: Mutex<Option<(String, Tools)>>,
    /// The in-process guard against running one agent twice at once.
    running: AtomicBool,
}

impl Agent {
    /// `providers` maps a provider name, the part of the model before the `/`, to a provider.
    /// Fails, before anything is stored, when the model's provider is missing or
    /// `max_concurrent_tools` is below 1.
    pub fn new(
        config: AgentConfig,
        store: Arc<dyn Store>,
        providers: HashMap<String, Arc<dyn Provider>>,
    ) -> Result<Agent> {
        let (name, model) = config.model.split_once('/').unwrap_or_default();
        let Some(provider) = providers.get(name).cloned() else {
            return Err(Error(format!(
                "No provider named {name} for the model {}.",
                config.model
            )));
        };
        if config.max_concurrent_tools < 1 {
            return Err(Error(format!(
                "max_concurrent_tools must be at least 1, not {}.",
                config.max_concurrent_tools
            )));
        }
        Ok(Agent {
            model: model.to_string(),
            config: Arc::new(config),
            store,
            provider,
            queue: Queue::default(),
            tools: Mutex::new(None),
            running: AtomicBool::new(false),
        })
    }

    pub fn config(&self) -> &AgentConfig {
        &self.config
    }

    /// Queues an event for the next delivery point, even while the agent runs. Give `parent_id`,
    /// an earlier entry, to rewind or branch the session.
    pub fn deliver(&self, event: Event, parent_id: Option<String>) {
        let queued = Queued {
            event,
            parent: parent_id,
        };
        self.queue.lock().expect("queue lock").push(queued);
    }

    /// Runs the agent until nothing new needs an answer, and returns why it ended. `stop` may be
    /// set at any time, from any task or thread. Errors are the store's, a plugin's `context`
    /// hook's, or a second run at once; a failing model or tool is recorded in the session instead.
    pub async fn run(&self, stop: Option<&StopSignal>) -> Result<Outcome> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(Error(format!(
                "Agent {} is already running.",
                self.config.id
            )));
        }
        let _running = Running(&self.running);
        let stop = stop.cloned().unwrap_or_default();

        // 1. Open a session if none is open. 2. Repair calls left without a result. 3. Deliver
        // waiting events.
        let (run, tools) = self.open(&stop).await?;
        run.repair().await?;
        run.deliver_waiting().await?;
        // 4. Freeze the context: the last context entry on the path, for the whole run.
        let context = run.render().await.0;
        // 5. Loop while the session needs a run.
        while run.needs_run().await {
            // i. Stop when the stop is set.
            if stop.is_set() {
                return run.stopped().await;
            }
            let request = Request {
                model: self.model.clone(),
                sections: context.sections.clone(),
                tools: context.tools.clone(),
                messages: run.render().await.1,
                max_tokens: self.config.max_tokens,
                output_schema: None,
                effort: self.config.effort.clone(),
                signal: Some(stop.clone()),
            };
            // ii. Call the provider. The stop abandons the call in flight, whatever the provider
            // does with the signal.
            let answer = tokio::select! {
                answer = self.provider.complete(&request) => answer,
                () = stop.wait() => Err(Error::new("The run was stopped.")),
            };
            let message = match answer {
                Ok(message) => message,
                Err(_) if stop.is_set() => return run.stopped().await,
                Err(error) => {
                    run.append_message(Message::Assistant(self.failed_message()))
                        .await?;
                    run.notice(format!("The model call failed: {error}"))
                        .await?;
                    return Ok(Outcome::Error);
                }
            };
            // iii. Append the assistant message.
            run.append_message(Message::Assistant(message.clone()))
                .await?;

            // iv. Run the calls, then append their results in call order.
            let calls: Vec<&ToolCall> = message.tool_calls().collect();
            let results = if message.stop == Stop::MaxTokens {
                // A response cut off by the token limit may hold a call with half its input.
                calls
                    .iter()
                    .map(|_| ToolResult::error(CUT_OFF_TEXT))
                    .collect()
            } else {
                self.run_tools(&run, &tools, &context.tools, &calls).await
            };
            for (call, result) in calls.iter().zip(results) {
                run.append_message(tool_message(call, result)).await?;
            }
            // v. A reset wins over a stop, since the model has already been told the session will
            // reset.
            if let Some(reason) = run.take_reset() {
                return run.end("agent", reason).await;
            }
            if !calls.is_empty() && stop.is_set() {
                return run.stopped().await;
            }
            // vi. Check the budget.
            let size = message.usage.size();
            if size > self.config.hard_limit {
                return run.end("harness", Some("context budget".into())).await;
            }
            if size > self.config.soft_limit && !run.has_soft_limit_notice().await {
                run.notice(SOFT_LIMIT_NOTICE).await?;
            }
            // vii. Deliver waiting events.
            run.deliver_waiting().await?;
        }
        // 6. End.
        Ok(Outcome::Idle)
    }

    /// Reads the agent's newest session and opens a new one when there is none, or when the
    /// newest ended in a reset. A newest session that holds only its header, because a process
    /// stopped after writing it, is opened in place. Loads the tools' code when this process has
    /// not yet.
    async fn open(&self, stop: &StopSignal) -> Result<(Arc<Run>, Tools)> {
        let (agent, store) = (&self.config.id, &self.store);
        let ids = store.list(agent).await?;
        let newest = match ids.last() {
            Some(id) => Some(store.read(agent, id).await?),
            None => None,
        };
        let reset_of = |session: &Session| match session.entries.last().map(|e| &e.body) {
            Some(EntryBody::Reset { reason, .. }) => Some(reason.clone()),
            _ => None,
        };

        if let Some(session) = newest
            .as_ref()
            .filter(|s| !s.entries.is_empty() && reset_of(s).is_none())
        {
            let id = session.header.id.clone();
            let run = self.start_run(session.clone(), stop);
            let cached = self.tools.lock().expect("tools lock").clone();
            let tools = match cached.filter(|(cached_for, _)| *cached_for == id) {
                Some((_, tools)) => tools,
                None => Arc::new(collect_context(&run).await?.tools),
            };
            *self.tools.lock().expect("tools lock") = Some((id, tools.clone()));
            return Ok((run, tools));
        }

        let header_only = newest.as_ref().is_some_and(|s| s.entries.is_empty());
        // The session whose reset says why this one starts: the one before a header-only newest.
        let started_after = match (header_only, ids.len()) {
            (false, _) => newest.as_ref().and_then(reset_of),
            (true, n) if n > 1 => reset_of(&store.read(agent, &ids[n - 2]).await?),
            (true, _) => None,
        };
        let session = match newest.filter(|_| header_only) {
            Some(session) => session,
            None => self.new_session(&ids)?,
        };
        let run = self.start_run(session.clone(), stop);
        // The plugins answer before anything is written, so that a clash of tool names leaves the
        // store untouched.
        let Contribution { sections, tools } = collect_context(&run).await?;
        if !header_only {
            store.create(&session.header).await?;
        }
        let definitions = tools.iter().map(|tool| tool.definition()).collect();
        run.append(
            EntryBody::Context {
                sections,
                tools: definitions,
            },
            None,
        )
        .await?;
        run.notice(match started_after {
            None => "Session started.".to_string(),
            Some(None) => "Session started after a reset.".to_string(),
            Some(Some(reason)) => format!("Session started after a reset: {reason}"),
        })
        .await?;
        let tools = Arc::new(tools);
        *self.tools.lock().expect("tools lock") = Some((session.header.id, tools.clone()));
        Ok((run, tools))
    }

    /// A session not yet in the store: its parent is the previous session, or the agent's parent.
    fn new_session(&self, ids: &[String]) -> Result<Session> {
        let now = now_iso();
        let parent = match ids.last() {
            Some(previous) => Some(ParentLink {
                session: previous.clone(),
                reason: "reset".into(),
                entry: None,
                agent: None,
            }),
            None => self.config.parent.clone(),
        };
        let header = Header {
            version: 1,
            id: new_session_id(&now, ids.last().map(String::as_str))?,
            agent: self.config.id.clone(),
            created_at: now,
            parent,
        };
        Ok(Session {
            header,
            entries: Vec::new(),
        })
    }

    fn start_run(&self, session: Session, stop: &StopSignal) -> Arc<Run> {
        Arc::new(Run {
            agent: self.config.clone(),
            store: self.store.clone(),
            queue: self.queue.clone(),
            stop: stop.clone(),
            session: tokio::sync::Mutex::new(session),
            reset: Mutex::new(None),
        })
    }

    /// What a failed model call leaves in the session.
    fn failed_message(&self) -> AssistantMessage {
        AssistantMessage {
            content: Vec::new(),
            model: self.config.model.clone(),
            usage: Usage::default(),
            stop: Stop::Error,
        }
    }

    /// Runs a turn's calls and returns their results in call order. The calls start in order:
    /// at most `max_concurrent_tools` at once, or one after another, with one place, when serial.
    async fn run_tools(
        &self,
        run: &Arc<Run>,
        tools: &Tools,
        definitions: &[ToolDefinition],
        calls: &[&ToolCall],
    ) -> Vec<ToolResult> {
        let places = match self.config.tool_execution {
            ToolExecution::Concurrent => self.config.max_concurrent_tools,
            ToolExecution::Serial => 1,
        };
        let turn = Arc::new(Turn {
            run: run.clone(),
            tools: tools.clone(),
            definitions: definitions.to_vec(),
            places: Arc::new(Semaphore::new(places)),
        });
        let calls = calls
            .iter()
            .enumerate()
            .map(|(index, call)| turn.run_limited(call, index));
        match self.config.tool_execution {
            // The semaphore is fair, and `join_all` asks for places in call order, so calls start
            // in call order.
            ToolExecution::Concurrent => join_all(calls).await,
            ToolExecution::Serial => {
                let mut results = Vec::new();
                for call in calls {
                    results.push(call.await);
                }
                results
            }
        }
    }
}

/// What a turn's calls share: the run, the tools as the frozen context names them, and the places
/// under the turn's limit. A call a tool makes with `Ctx::run_tool` takes a place like any other.
pub(crate) struct Turn {
    run: Arc<Run>,
    tools: Tools,
    definitions: Vec<ToolDefinition>,
    places: Arc<Semaphore>,
}

impl Turn {
    /// Runs a call under the turn's limit, with the index of the model's call it belongs to. Once
    /// the stop is set, a call that has not started never starts.
    pub(crate) async fn run_limited(self: &Arc<Self>, call: &ToolCall, index: usize) -> ToolResult {
        let permit =
            (self.places.clone().acquire_owned().await).expect("the semaphore is never closed");
        if self.run.stop.is_set() {
            return ToolResult::error(REPAIR_TEXT);
        }
        let place = Arc::new(Place {
            places: self.places.clone(),
            state: std::sync::Mutex::new(PlaceState {
                permit: Some(permit),
                waiting: 0,
                finished: false,
            }),
        });
        let ctx = Ctx::for_call(self.run.clone(), index, self.clone(), place.clone());
        let result = run_call(&self.run, &self.tools, &self.definitions, call, &ctx).await;
        place.finish();
        result
    }
}

/// A running call's place under the turn's limit. While the calls it made with `Ctx::run_tool`
/// run, the call gives up its place, and it takes one back when the last of them finishes, so a
/// tool never waits on its own place. When the call ends while calls it made still run, it has no
/// place to give back, and takes none.
pub(crate) struct Place {
    places: Arc<Semaphore>,
    state: std::sync::Mutex<PlaceState>,
}

struct PlaceState {
    permit: Option<OwnedSemaphorePermit>,
    waiting: usize,
    finished: bool,
}

impl Place {
    pub(crate) fn give_up(&self) {
        let mut state = self.state.lock().expect("place lock");
        state.waiting += 1;
        state.permit = None;
    }

    /// Waits for a place without holding the lock, so that a call made meanwhile can give up the
    /// place at once, and keeps it only if the tool still wants it once the place is free.
    pub(crate) async fn take_back(&self) {
        {
            let mut state = self.state.lock().expect("place lock");
            state.waiting -= 1;
            if state.waiting > 0 || state.finished {
                return;
            }
        }
        let permit = self.places.clone().acquire_owned().await;
        let permit = permit.expect("the semaphore is never closed");
        let mut state = self.state.lock().expect("place lock");
        // Otherwise the place goes back as `permit` drops: a newer call gave it up, the tool
        // ended, or another take_back got there first.
        if state.waiting == 0 && !state.finished && state.permit.is_none() {
            state.permit = Some(permit);
        }
    }

    fn finish(&self) {
        let mut state = self.state.lock().expect("place lock");
        state.finished = true;
        state.permit = None;
    }
}

/// Clears the running flag however a run ends, even when its future is dropped.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Calls every plugin's `context` hook, in plugin order, joins what they add, and adds the core
/// `reset` tool last. Fails when a hook fails, naming its plugin, or when two tools would share a
/// name.
async fn collect_context(run: &Arc<Run>) -> Result<Contribution> {
    let mut joined = Contribution::default();
    let ctx = Ctx::opening(run.clone());
    for plugin in &run.agent.plugins {
        let contribution = plugin
            .context(&ctx)
            .await
            .map_err(|error| Error(format!("The {} plugin failed: {}", plugin.name(), error.0)))?;
        joined.sections.extend(contribution.sections);
        joined.tools.extend(contribution.tools);
    }
    joined.tools.push(Box::new(ResetTool));
    let mut names = HashSet::new();
    for tool in &joined.tools {
        let name = tool.definition().name;
        if !names.insert(name.clone()) {
            return Err(Error(format!("Two tools are named {name}.")));
        }
    }
    Ok(joined)
}

/// One call, as docs/spec/plugins.md describes: find the tool, check the input, let the plugins
/// replace the call, run it, then pass the result through the plugins. A failing hook is a bug in
/// its plugin: the call gets an error result naming the plugin, and no later hook runs for it.
async fn run_call(
    run: &Arc<Run>,
    tools: &[Box<dyn Tool>],
    definitions: &[ToolDefinition],
    call: &ToolCall,
    ctx: &Ctx,
) -> ToolResult {
    let definition = definitions.iter().find(|tool| tool.name == call.name);
    let code = tools
        .iter()
        .find(|tool| tool.definition().name == call.name);
    let (Some(definition), Some(code)) = (definition, code) else {
        return ToolResult::error(format!("No tool named {}.", call.name));
    };
    let input = match check_input(definition, &call.input) {
        Ok(input) => input,
        Err(problem) => return ToolResult::error(problem),
    };
    let failed = |plugin: &dyn Plugin, error: Error| {
        ToolResult::error(format!("The {} plugin failed: {}", plugin.name(), error.0))
    };
    let mut replaced = None;
    for plugin in &run.agent.plugins {
        match plugin.before_tool(call, ctx).await {
            Ok(None) => {}
            Ok(result) => {
                replaced = result;
                break;
            }
            Err(error) => return failed(plugin.as_ref(), error),
        }
    }
    let mut result = match replaced {
        Some(result) => result,
        None => code
            .run(input, ctx)
            .await
            .unwrap_or_else(|error| ToolResult::error(error.0)),
    };
    for plugin in &run.agent.plugins {
        result = match plugin.after_tool(call, result, ctx).await {
            Ok(result) => result,
            Err(error) => return failed(plugin.as_ref(), error),
        };
    }
    result
}

/// One run's view of the open session: the session as read at the start, plus everything the run
/// appends. Hooks and tools reach it through `Ctx`, so it is shared, and the session sits behind
/// a lock that each append holds until the entry is written.
pub(crate) struct Run {
    pub(crate) agent: Arc<AgentConfig>,
    store: Arc<dyn Store>,
    queue: Queue,
    pub(crate) stop: StopSignal,
    pub(crate) session: tokio::sync::Mutex<Session>,
    /// The reset the earliest call in call order asked for this turn: its index and its reason.
    reset: Mutex<Option<(usize, Option<String>)>>,
}

impl Run {
    /// Appends an entry after `parent`, or after the head when `parent` is `None`, then tells the
    /// plugins. It is boxed because a plugin's `on_entry` may append in turn.
    pub(crate) fn append(
        self: &Arc<Self>,
        body: EntryBody,
        parent: Option<String>,
    ) -> BoxFuture<'static, Result<()>> {
        let run = self.clone();
        Box::pin(async move {
            let entry = {
                let mut session = run.session.lock().await;
                if let Some(EntryBody::Reset { .. }) = session.entries.last().map(|e| &e.body) {
                    return Err(Error::new("Nothing may follow a reset."));
                }
                let taken: HashSet<&str> = session.entries.iter().map(|e| e.id.as_str()).collect();
                let id = std::iter::repeat_with(new_entry_id)
                    .find(|id| !taken.contains(id.as_str()))
                    .expect("an unused entry id");
                let head = session.entries.last().map(|e| e.id.clone());
                let entry = Entry {
                    id,
                    parent_id: parent.or(head),
                    at: now_iso(),
                    body,
                };
                let header = &session.header;
                run.store.append(&header.agent, &header.id, &entry).await?;
                session.entries.push(entry.clone());
                entry
            };
            let ctx = Ctx::new(run.clone());
            for plugin in &run.agent.plugins {
                plugin.on_entry(&entry, &ctx).await;
            }
            Ok(())
        })
    }

    async fn append_message(self: &Arc<Self>, message: Message) -> Result<()> {
        self.append(EntryBody::Message { message }, None).await
    }

    async fn notice(self: &Arc<Self>, text: impl Into<String>) -> Result<()> {
        self.append(EntryBody::Event(Event::notice(text)), None)
            .await
    }

    async fn stopped(self: &Arc<Self>) -> Result<Outcome> {
        let who = self.stop.who().unwrap_or_else(|| "the host".into());
        self.notice(format!("Stopped by {who}.")).await?;
        Ok(Outcome::Stopped)
    }

    pub(crate) fn queue(&self, event: Event, parent: Option<String>) {
        self.queue
            .lock()
            .expect("queue lock")
            .push(Queued { event, parent });
    }

    /// Keeps the request of the earliest call in call order, and that call's first request.
    pub(crate) fn request_reset(&self, call: usize, reason: Option<String>) {
        let mut reset = self.reset.lock().expect("reset lock");
        if reset.as_ref().is_none_or(|(earliest, _)| call < *earliest) {
            *reset = Some((call, reason));
        }
    }

    fn take_reset(&self) -> Option<Option<String>> {
        let reset = self.reset.lock().expect("reset lock").take();
        reset.map(|(_, reason)| reason)
    }

    /// The context and messages the model sees, from the path as it is now.
    async fn render(&self) -> (Context, Vec<Message>) {
        render(&path_of(&self.session.lock().await.entries))
    }

    /// Gives each tool call of the last assistant message that has no result an error result, so
    /// that after a crash the model never sees a call with no answer.
    async fn repair(self: &Arc<Self>) -> Result<()> {
        let missing = unanswered(&path_of(&self.session.lock().await.entries));
        for call in missing {
            self.append_message(tool_message(&call, ToolResult::error(REPAIR_TEXT)))
                .await?;
        }
        Ok(())
    }

    /// Appends every queued event, in order. A rewound event goes to the head instead when its
    /// parent is not in this session, or when the path up to its parent would leave a tool call
    /// without its result, as docs/spec/sessions.md describes.
    async fn deliver_waiting(self: &Arc<Self>) -> Result<()> {
        loop {
            let next = {
                let mut queue = self.queue.lock().expect("queue lock");
                (!queue.is_empty()).then(|| queue.remove(0))
            };
            let Some(Queued { event, parent }) = next else {
                return Ok(());
            };
            let parent = {
                let session = self.session.lock().await;
                parent.filter(|id| can_rewind_to(&session.entries, id))
            };
            self.append(EntryBody::Event(event), parent).await?;
        }
    }

    /// A session needs a run when the last entry on its path, leaving out context and custom
    /// entries, is a tool result or an event from outside the harness. The harness's own
    /// notices need no answer, except the soft-limit notice, which asks the agent to act, even
    /// when stop notices have followed it.
    async fn needs_run(&self) -> bool {
        let session = self.session.lock().await;
        let path = path_of(&session.entries);
        let mut after_stop = false;
        for entry in path.iter().rev() {
            match &entry.body {
                EntryBody::Context { .. } | EntryBody::Custom { .. } => continue,
                EntryBody::Event(event) if from_harness(event) => {
                    if event.text == SOFT_LIMIT_NOTICE {
                        return true;
                    }
                    let stopped =
                        event.text.starts_with("Stopped by ") && event.text.ends_with('.');
                    if !stopped {
                        return false;
                    }
                    after_stop = true;
                }
                EntryBody::Event(_) => return !after_stop,
                EntryBody::Message {
                    message: Message::Tool(_),
                } => return !after_stop,
                _ => return false,
            }
        }
        false
    }

    /// Looks in every entry, not only the path, so that a rewind never brings a second warning.
    async fn has_soft_limit_notice(&self) -> bool {
        let session = self.session.lock().await;
        session.entries.iter().any(|e| match &e.body {
            EntryBody::Event(event) => from_harness(event) && event.text == SOFT_LIMIT_NOTICE,
            _ => false,
        })
    }

    /// Appends a `reset` and tells the plugins the session has ended.
    async fn end(self: &Arc<Self>, by: &str, reason: Option<String>) -> Result<Outcome> {
        let body = EntryBody::Reset {
            by: by.into(),
            reason,
        };
        self.append(body, None).await?;
        let session = self.session.lock().await.clone();
        let ctx = Ctx::ended(self.clone());
        for plugin in &self.agent.plugins {
            plugin.on_session_end(&session, &ctx).await;
        }
        Ok(Outcome::Reset)
    }
}

/// The calls of the last assistant message on the path that have no `tool` message after it.
fn unanswered(path: &[&Entry]) -> Vec<ToolCall> {
    let Some(at) = path.iter().rposition(|e| assistant(e).is_some()) else {
        return Vec::new();
    };
    let answered: HashSet<&str> = path[at + 1..]
        .iter()
        .filter_map(|e| match &e.body {
            EntryBody::Message {
                message: Message::Tool(result),
            } => Some(result.call_id.as_str()),
            _ => None,
        })
        .collect();
    let message = assistant(path[at]).expect("found as an assistant message");
    message
        .tool_calls()
        .filter(|call| !answered.contains(call.id.as_str()))
        .cloned()
        .collect()
}

/// A rewind stays inside the open session and never leaves a call without its result.
fn can_rewind_to(entries: &[Entry], id: &str) -> bool {
    // Parents come before their children, so the path to the target ends at the target.
    match entries.iter().position(|e| e.id == id) {
        Some(at) => unanswered(&path_of(&entries[..=at])).is_empty(),
        None => false,
    }
}

fn assistant(entry: &Entry) -> Option<&AssistantMessage> {
    match &entry.body {
        EntryBody::Message {
            message: Message::Assistant(message),
        } => Some(message),
        _ => None,
    }
}

fn from_harness(event: &Event) -> bool {
    event
        .attrs
        .as_ref()
        .and_then(|attrs| attrs.get("from"))
        .is_some_and(|from| from == "harness")
}

fn tool_message(call: &ToolCall, result: ToolResult) -> Message {
    Message::Tool(ToolMessage {
        call_id: call.id.clone(),
        name: call.name.clone(),
        content: result.content,
        is_error: result.is_error,
    })
}

/// The least check the spec asks for: the input is an object, and has every required property.
/// The wording is fixed, because the conformance suite checks it.
fn check_input<'i>(
    definition: &ToolDefinition,
    input: &'i Value,
) -> std::result::Result<&'i Map<String, Value>, String> {
    let name = &definition.name;
    let Some(object) = input.as_object() else {
        return Err(format!("Invalid input for {name}: expected an object."));
    };
    let required = definition
        .input_schema
        .get("required")
        .and_then(Value::as_array);
    for property in required.into_iter().flatten().filter_map(Value::as_str) {
        if !object.contains_key(property) {
            return Err(format!(
                "Invalid input for {name}: missing required property \"{property}\"."
            ));
        }
    }
    Ok(object)
}

/// The one tool the core provides.
struct ResetTool;

#[async_trait]
impl Tool for ResetTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "reset".into(),
            description: RESET_DESCRIPTION.into(),
            input_schema: json!({"type": "object", "properties": {"reason": {"type": "string"}}}),
        }
    }

    async fn run(&self, input: &Map<String, Value>, ctx: &Ctx) -> Result<ToolResult> {
        let reason = input
            .get("reason")
            .and_then(Value::as_str)
            .map(String::from);
        ctx.request_reset(reason);
        Ok(ToolResult::text(RESET_RESULT))
    }
}
