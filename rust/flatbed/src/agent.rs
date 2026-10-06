//! The loop, as docs/spec/loop.md describes: open a session if none is open, repair it, deliver
//! waiting events, then ask the model and run its tools until nothing new needs an answer.
//! `Agent::run` is the whole harness; everything below it is one step of it.

use crate::error::{Error, Result};
use crate::ids::{new_entry_id, new_session_id, now_iso};
use crate::plugin::{Contribution, Ctx, Outputs, Plugin, Tool, ToolResult};
use crate::providers::{Provider, Request};
use crate::render::{path_of, render, Context};
use crate::store::Store;
use crate::types::{
    AssistantMessage, Entry, EntryBody, Event, Header, Message, ParentLink, Session, Stop,
    ToolCall, ToolDefinition, ToolMessage, Usage,
};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

const SOFT_LIMIT_NOTICE: &str =
    "This session is nearly full. Bring your notes up to date, then call reset.";
const REPAIR_TEXT: &str = "The harness stopped before this tool ran.";
const CUT_OFF_TEXT: &str = "The response was cut off before this call was complete.";
const RESET_RESULT: &str = "Session will reset after this turn.";
const RESET_DESCRIPTION: &str = "End this session and start a fresh one. Call it when your notes are up to date and the session is long, or when the work is finished. Anything not written down will be forgotten.";

/// An agent as the host configures it. The core stores nothing about it beyond its sessions.
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
        }
    }
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

/// Stops a run at its next turn. It names who stopped it, for the notice. It can be shared with
/// another thread, such as a Ctrl-C handler.
#[derive(Clone, Debug, Default)]
pub struct StopSignal(Arc<Mutex<Option<String>>>);

impl StopSignal {
    pub fn new() -> StopSignal {
        StopSignal::default()
    }

    pub fn stop(&self, who: impl Into<String>) {
        *self.0.lock().expect("stop signal lock") = Some(who.into());
    }

    pub fn stopped_by(&self) -> Option<String> {
        self.0.lock().expect("stop signal lock").clone()
    }
}

/// An event waiting for the next delivery point, with the entry to follow when rewinding.
struct Queued {
    event: Event,
    parent: Option<String>,
}

pub struct Agent {
    pub config: AgentConfig,
    store: Rc<dyn Store>,
    providers: HashMap<String, Rc<dyn Provider>>,
    queue: Vec<Queued>,
    /// The tools' code for the open session, kept between runs. The session's `context` entry
    /// says which tools exist; the plugins supply their code.
    tools: Option<(String, Vec<Box<dyn Tool>>)>,
}

impl Agent {
    /// `providers` maps a provider name, the part of the model before the `/`, to a provider.
    pub fn new(
        config: AgentConfig,
        store: Rc<dyn Store>,
        providers: HashMap<String, Rc<dyn Provider>>,
    ) -> Agent {
        Agent {
            config,
            store,
            providers,
            queue: Vec::new(),
            tools: None,
        }
    }

    /// Queues an event for the next delivery point.
    pub fn deliver(&mut self, event: Event) {
        self.queue.push(Queued {
            event,
            parent: None,
        });
    }

    /// Queues an event that follows `parent`, an earlier entry, to rewind or branch the session.
    pub fn deliver_after(&mut self, event: Event, parent: impl Into<String>) {
        self.queue.push(Queued {
            event,
            parent: Some(parent.into()),
        });
    }

    /// Runs the agent until nothing new needs an answer. Taking `&mut self` is the in-process
    /// guard against running one agent twice at once. Errors are the store's; a failing model or
    /// tool is recorded in the session instead.
    pub fn run(&mut self, signal: Option<&StopSignal>) -> Result<Outcome> {
        let stopped_by = || signal.and_then(StopSignal::stopped_by);
        let mut run = self.start()?;
        run.repair()?;
        run.deliver_waiting()?;
        while run.needs_run() {
            if let Some(who) = stopped_by() {
                run.notice(format!("Stopped by {who}."))?;
                return Ok(Outcome::Stopped);
            }
            let message = match run.ask_model(signal) {
                Ok(message) => message,
                // A call that failed because the run was stopped is a stop, which the top of the
                // loop records.
                Err(_) if stopped_by().is_some() => continue,
                Err(error) => {
                    run.append_message(Message::Assistant(run.failed_message()))?;
                    run.notice(format!("The model call failed: {error}"))?;
                    return Ok(Outcome::Error);
                }
            };
            run.append_message(Message::Assistant(message.clone()))?;
            if let Some(reason) = run.run_tools(&message)? {
                run.end("agent", reason)?;
                return Ok(Outcome::Reset);
            }
            let size = message.usage.size();
            if size > run.agent.hard_limit {
                run.end("harness", Some("context budget".into()))?;
                return Ok(Outcome::Reset);
            }
            if size > run.agent.soft_limit && !run.has_notice(SOFT_LIMIT_NOTICE) {
                run.notice(SOFT_LIMIT_NOTICE)?;
            }
            run.deliver_waiting()?;
        }
        Ok(Outcome::Idle)
    }

    /// Reads the agent's newest session and opens a new one when there is none, or when the
    /// newest ended in a reset. Loads the tools' code when this process has not yet.
    fn start(&mut self) -> Result<Run<'_>> {
        let Agent {
            config,
            store,
            providers,
            queue,
            tools,
        } = self;
        let ids = store.list(&config.id)?;
        let newest = match ids.last() {
            Some(id) => Some(store.read(&config.id, id)?),
            None => None,
        };
        let ended_with =
            newest
                .as_ref()
                .and_then(|session| match session.entries.last().map(|e| &e.body) {
                    Some(EntryBody::Reset { reason, .. }) => Some(reason.clone()),
                    _ => None,
                });
        if let (Some(session), None) = (&newest, &ended_with) {
            let loaded = tools
                .as_ref()
                .is_some_and(|(id, _)| *id == session.header.id);
            let mut outputs = Outputs::default();
            if !loaded {
                let code = collect_context(config, session, &mut outputs)?.tools;
                *tools = Some((session.header.id.clone(), code));
            }
            let mut run = Run::new(config, &**store, providers, queue, tools, newest.unwrap());
            run.apply(outputs)?;
            run.freeze_context();
            return Ok(run);
        }

        let now = now_iso();
        let header = Header {
            version: 1,
            id: new_session_id(&now, ids.last().map(String::as_str))?,
            agent: config.id.clone(),
            created_at: now,
            parent: newest.map(|previous| ParentLink {
                session: previous.header.id,
                reason: "reset".into(),
                entry: None,
            }),
        };
        let session = Session {
            header,
            entries: Vec::new(),
        };
        let mut outputs = Outputs::default();
        let Contribution {
            sections,
            tools: code,
        } = collect_context(config, &session, &mut outputs)?;
        let definitions = code.iter().map(|tool| tool.definition()).collect();
        store.create(&session.header)?;
        *tools = Some((session.header.id.clone(), code));
        let mut run = Run::new(config, &**store, providers, queue, tools, session);
        run.append(
            EntryBody::Context {
                sections,
                tools: definitions,
            },
            None,
        )?;
        run.notice(match ended_with {
            None => "Session started.".to_string(),
            Some(None) => "Session started after a reset.".to_string(),
            Some(Some(reason)) => format!("Session started after a reset: {reason}"),
        })?;
        run.apply(outputs)?;
        run.freeze_context();
        Ok(run)
    }
}

/// Calls every plugin's `context` hook, in plugin order, joins what they add, and adds the core
/// `reset` tool last.
fn collect_context(
    config: &AgentConfig,
    session: &Session,
    outputs: &mut Outputs,
) -> Result<Contribution> {
    let mut joined = Contribution::default();
    for plugin in &config.plugins {
        let mut ctx = Ctx::new(config, session);
        let contribution = plugin.context(&mut ctx)?;
        joined.sections.extend(contribution.sections);
        joined.tools.extend(contribution.tools);
        outputs.merge(ctx.outputs);
    }
    joined.tools.push(Box::new(ResetTool));
    Ok(joined)
}

/// One run's view of the open session: the session as read at the start, plus everything the
/// run appends. Every append goes to the store and to `session.entries`, then to the plugins.
struct Run<'a> {
    agent: &'a AgentConfig,
    store: &'a dyn Store,
    providers: &'a HashMap<String, Rc<dyn Provider>>,
    queue: &'a mut Vec<Queued>,
    tools: &'a [Box<dyn Tool>],
    session: Session,
    /// The last `context` entry on the path, taken once for the whole run.
    context: Context,
}

impl<'a> Run<'a> {
    fn new(
        agent: &'a AgentConfig,
        store: &'a dyn Store,
        providers: &'a HashMap<String, Rc<dyn Provider>>,
        queue: &'a mut Vec<Queued>,
        tools: &'a Option<(String, Vec<Box<dyn Tool>>)>,
        session: Session,
    ) -> Run<'a> {
        let tools = tools
            .as_ref()
            .map(|(_, code)| code.as_slice())
            .unwrap_or(&[]);
        Run {
            agent,
            store,
            providers,
            queue,
            tools,
            session,
            context: Context::default(),
        }
    }

    fn freeze_context(&mut self) {
        self.context = render(&path_of(&self.session.entries)).0;
    }

    /// Appends an entry after `parent`, or after the head when `parent` is `None`.
    fn append(&mut self, body: EntryBody, parent: Option<String>) -> Result<()> {
        let taken: HashSet<&str> = self.session.entries.iter().map(|e| e.id.as_str()).collect();
        let id = std::iter::repeat_with(new_entry_id)
            .find(|id| !taken.contains(id.as_str()))
            .expect("an unused entry id");
        let head = self.session.entries.last().map(|e| e.id.clone());
        let entry = Entry {
            id,
            parent_id: parent.or(head),
            at: now_iso(),
            body,
        };
        let header = &self.session.header;
        self.store.append(&header.agent, &header.id, &entry)?;
        self.session.entries.push(entry);
        let mut outputs = Outputs::default();
        let entry = self
            .session
            .entries
            .last()
            .expect("the entry just appended");
        for plugin in &self.agent.plugins {
            let mut ctx = Ctx::new(self.agent, &self.session);
            plugin.on_entry(entry, &mut ctx);
            outputs.merge(ctx.outputs);
        }
        self.apply(outputs)
    }

    fn append_message(&mut self, message: Message) -> Result<()> {
        self.append(EntryBody::Message { message }, None)
    }

    fn notice(&mut self, text: impl Into<String>) -> Result<()> {
        self.append(EntryBody::Event(Event::notice(text)), None)
    }

    /// Writes what a hook appended, and queues what it delivered.
    fn apply(&mut self, outputs: Outputs) -> Result<()> {
        for body in outputs.appended {
            self.append(body, None)?;
        }
        self.queue
            .extend(outputs.delivered.into_iter().map(|event| Queued {
                event,
                parent: None,
            }));
        Ok(())
    }

    /// Gives each tool call of the last assistant message that has no result an error result, so
    /// that after a crash the model never sees a call with no answer.
    fn repair(&mut self) -> Result<()> {
        let path = path_of(&self.session.entries);
        let Some(at) = path.iter().rposition(|e| assistant(e).is_some()) else {
            return Ok(());
        };
        let answered: HashSet<&str> = path[at + 1..]
            .iter()
            .filter_map(|e| tool_result_id(e))
            .collect();
        let missing: Vec<ToolCall> = assistant(path[at])
            .expect("found as an assistant message")
            .tool_calls()
            .filter(|call| !answered.contains(call.id.as_str()))
            .cloned()
            .collect();
        for call in missing {
            self.append_message(tool_message(&call, ToolResult::error(REPAIR_TEXT)))?;
        }
        Ok(())
    }

    /// Appends every queued event, in order. A rewound event goes to the head instead when its
    /// parent is not in this session, or when the path up to its parent would leave a tool call
    /// without its result, as docs/spec/sessions.md describes.
    fn deliver_waiting(&mut self) -> Result<()> {
        while !self.queue.is_empty() {
            let Queued { event, parent } = self.queue.remove(0);
            let parent = parent.filter(|id| self.can_rewind_to(id));
            self.append(EntryBody::Event(event), parent)?;
        }
        Ok(())
    }

    fn can_rewind_to(&self, id: &str) -> bool {
        let Some(at) = self.session.entries.iter().position(|e| e.id == id) else {
            return false;
        };
        let path = path_of(&self.session.entries[..=at]);
        let Some(last) = path.iter().rposition(|e| assistant(e).is_some()) else {
            return true;
        };
        let answered: HashSet<&str> = path[last + 1..]
            .iter()
            .filter_map(|e| tool_result_id(e))
            .collect();
        assistant(path[last])
            .expect("found as an assistant message")
            .tool_calls()
            .all(|call| answered.contains(call.id.as_str()))
    }

    /// A session needs a run when the last entry on its path, leaving out context and custom
    /// entries, is a tool result or an event from outside the harness. The harness's own
    /// notices need no answer, except the soft-limit notice, which asks the agent to act.
    fn needs_run(&self) -> bool {
        let path = path_of(&self.session.entries);
        let last = path
            .iter()
            .rev()
            .find(|e| !matches!(e.body, EntryBody::Context { .. } | EntryBody::Custom { .. }));
        match last.map(|e| &e.body) {
            Some(EntryBody::Message {
                message: Message::Tool(_),
            }) => true,
            Some(EntryBody::Event(event)) => {
                !from_harness(event) || event.text == SOFT_LIMIT_NOTICE
            }
            _ => false,
        }
    }

    fn has_notice(&self, text: &str) -> bool {
        self.session.entries.iter().any(|e| match &e.body {
            EntryBody::Event(event) => from_harness(event) && event.text == text,
            _ => false,
        })
    }

    fn ask_model(&self, signal: Option<&StopSignal>) -> Result<AssistantMessage> {
        let (_, messages) = render(&path_of(&self.session.entries));
        let (provider_name, model) =
            self.agent.model.split_once('/').ok_or_else(|| {
                Error(format!("The model {} names no provider.", self.agent.model))
            })?;
        let provider = self
            .providers
            .get(provider_name)
            .ok_or_else(|| Error(format!("No provider named {provider_name}.")))?;
        provider.complete(&Request {
            model: model.to_string(),
            sections: self.context.sections.clone(),
            tools: self.context.tools.clone(),
            messages,
            max_tokens: self.agent.max_tokens,
            output_schema: None,
            effort: self.agent.effort.clone(),
            signal: signal.cloned(),
        })
    }

    /// What a failed model call leaves in the session.
    fn failed_message(&self) -> AssistantMessage {
        AssistantMessage {
            content: Vec::new(),
            model: self.agent.model.clone(),
            usage: Usage::default(),
            stop: Stop::Error,
        }
    }

    /// Runs the message's tool calls one at a time and appends their results in call order.
    /// Returns the reset a tool asked for, with its reason, if any did.
    fn run_tools(&mut self, message: &AssistantMessage) -> Result<Option<Option<String>>> {
        let mut results = Vec::new();
        let mut reset = None;
        for call in message.tool_calls() {
            // A response cut off by the token limit may hold a call with half its input.
            let result = if message.stop == Stop::MaxTokens {
                ToolResult::error(CUT_OFF_TEXT)
            } else {
                let (result, outputs) = self.run_call(call);
                reset = reset.or(outputs.reset.clone());
                self.apply(outputs)?;
                result
            };
            results.push(tool_message(call, result));
        }
        for result in results {
            self.append_message(result)?;
        }
        Ok(reset)
    }

    /// One call, as docs/spec/plugins.md describes: find the tool, check the input, let the
    /// plugins replace the call, run it, then pass the result through the plugins.
    fn run_call(&self, call: &ToolCall) -> (ToolResult, Outputs) {
        let definition = self
            .context
            .tools
            .iter()
            .find(|tool| tool.name == call.name);
        let code = self
            .tools
            .iter()
            .find(|tool| tool.definition().name == call.name);
        let (Some(definition), Some(code)) = (definition, code) else {
            let result = ToolResult::error(format!("No tool named {}.", call.name));
            return (result, Outputs::default());
        };
        let input = match check_input(definition, &call.input) {
            Ok(input) => input,
            Err(problem) => return (ToolResult::error(problem), Outputs::default()),
        };
        let mut ctx = Ctx::new(self.agent, &self.session);
        let mut replaced = None;
        for plugin in &self.agent.plugins {
            match plugin.before_tool(call, &mut ctx) {
                Ok(None) => continue,
                Ok(Some(result)) => replaced = Some(result),
                Err(error) => replaced = Some(ToolResult::error(error.0)),
            }
            break;
        }
        let mut result = replaced.unwrap_or_else(|| {
            code.run(input, &mut ctx)
                .unwrap_or_else(|error| ToolResult::error(error.0))
        });
        for plugin in &self.agent.plugins {
            result = plugin
                .after_tool(call, result, &mut ctx)
                .unwrap_or_else(|error| ToolResult::error(error.0));
        }
        (result, ctx.outputs)
    }

    /// Appends a `reset` and tells the plugins the session has ended.
    fn end(&mut self, by: &str, reason: Option<String>) -> Result<()> {
        self.append(
            EntryBody::Reset {
                by: by.into(),
                reason,
            },
            None,
        )?;
        let mut outputs = Outputs::default();
        for plugin in &self.agent.plugins {
            let mut ctx = Ctx::ended(self.agent, &self.session);
            plugin.on_session_end(&self.session, &mut ctx);
            outputs.merge(ctx.outputs);
        }
        // Only deliveries can come out of an ended context; they wait for the next session.
        self.apply(outputs)
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

/// The call id a `tool` message answers.
fn tool_result_id(entry: &Entry) -> Option<&str> {
    match &entry.body {
        EntryBody::Message {
            message: Message::Tool(result),
        } => Some(&result.call_id),
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

impl Tool for ResetTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "reset".into(),
            description: RESET_DESCRIPTION.into(),
            input_schema: json!({"type": "object", "properties": {"reason": {"type": "string"}}}),
        }
    }

    fn run(&self, input: &Map<String, Value>, ctx: &mut Ctx) -> Result<ToolResult> {
        let reason = input
            .get("reason")
            .and_then(Value::as_str)
            .map(String::from);
        ctx.request_reset(reason);
        Ok(ToolResult::text(RESET_RESULT))
    }
}
