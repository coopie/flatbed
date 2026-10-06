//! The conformance runner, as docs/spec/conformance.md describes. It runs every scenario in
//! `conformance/scenarios/` against a memory store with the faux provider, prints `ok <name>` or
//! `FAIL <name>: <first difference>` for each, and exits non-zero on any failure.
//!
//!   cargo run --bin conformance [scenario-dir]

use flatbed::providers::faux::{Faux, Script, Scripted};
use flatbed::render::path_of;
use flatbed::{
    Agent, AgentConfig, Block, Contribution, Ctx, Entry, EntryBody, Event, MemoryStore, Message,
    Plugin, Provider, Section, Session, Stop, StopSignal, Store, Tool, ToolCall, ToolDefinition,
    ToolResult, Usage,
};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

#[derive(Deserialize)]
struct Scenario {
    name: String,
    agent: ScenarioAgent,
    #[serde(default)]
    sections: Vec<Section>,
    #[serde(default)]
    tools: Vec<ScenarioTool>,
    #[serde(default)]
    plugin: Hooks,
    script: Vec<ScriptStep>,
    steps: Vec<Value>,
    expect: Expect,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioAgent {
    model: String,
    soft_limit: Option<u64>,
    hard_limit: Option<u64>,
    max_tokens: Option<u32>,
}

/// What the test plugin does beyond giving sections and tools.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hooks {
    /// A result to use in place of running the named tool.
    before_tool: Option<HashMap<String, ResultJson>>,
    /// A result to replace the named tool's result with.
    after_tool: Option<HashMap<String, ResultJson>>,
    /// Data for a custom entry appended after each tool message.
    on_entry: Option<CustomJson>,
    /// An event to deliver when the session ends.
    on_session_end: Option<DeliverJson>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultJson {
    content: Vec<Block>,
    is_error: bool,
}

impl ResultJson {
    fn result(&self) -> ToolResult {
        ToolResult {
            content: self.content.clone(),
            is_error: self.is_error,
        }
    }
}

#[derive(Clone, Deserialize)]
struct CustomJson {
    custom: Value,
}

#[derive(Clone, Deserialize)]
struct DeliverJson {
    deliver: Event,
}

/// A scripted response, or `{"abort": "<who>"}`: set the stop signal while the call is in flight,
/// and fail the call.
#[derive(Deserialize)]
#[serde(untagged)]
enum ScriptStep {
    Abort { abort: String },
    Response(ScriptedJson),
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioTool {
    name: String,
    description: String,
    input_schema: Value,
    behaviour: Value,
}

#[derive(Deserialize)]
struct ScriptedJson {
    content: Vec<Block>,
    usage: Option<Usage>,
    stop: Option<Stop>,
}

#[derive(Deserialize)]
struct Expect {
    sessions: Vec<Vec<Value>>,
    requests: Option<Vec<Value>>,
}

/// The test plugin: the scenario's sections and tools, from its `context` hook.
struct ScenarioPlugin {
    sections: Vec<Section>,
    tools: Vec<ScenarioTool>,
    hooks: Hooks,
}

impl Plugin for ScenarioPlugin {
    fn name(&self) -> &str {
        "scenario"
    }

    fn context(&self, _ctx: &mut Ctx) -> flatbed::Result<Contribution> {
        Ok(Contribution {
            sections: self.sections.clone(),
            tools: self
                .tools
                .iter()
                .map(|tool| Box::new(tool.clone()) as Box<dyn Tool>)
                .collect(),
        })
    }

    fn before_tool(&self, call: &ToolCall, _ctx: &mut Ctx) -> flatbed::Result<Option<ToolResult>> {
        let found = self
            .hooks
            .before_tool
            .as_ref()
            .and_then(|by_name| by_name.get(&call.name));
        Ok(found.map(ResultJson::result))
    }

    fn after_tool(
        &self,
        call: &ToolCall,
        result: ToolResult,
        _ctx: &mut Ctx,
    ) -> flatbed::Result<ToolResult> {
        let found = self
            .hooks
            .after_tool
            .as_ref()
            .and_then(|by_name| by_name.get(&call.name));
        Ok(found.map(ResultJson::result).unwrap_or(result))
    }

    fn on_entry(&self, entry: &Entry, ctx: &mut Ctx) {
        let is_result = matches!(
            &entry.body,
            EntryBody::Message {
                message: Message::Tool(_)
            }
        );
        if let (Some(hook), true) = (&self.hooks.on_entry, is_result) {
            ctx.append("test", hook.custom.clone())
                .expect("the session is open");
        }
    }

    fn on_session_end(&self, _session: &Session, ctx: &mut Ctx) {
        if let Some(hook) = &self.hooks.on_session_end {
            ctx.deliver(hook.deliver.clone());
        }
    }
}

impl Tool for ScenarioTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema: self.input_schema.clone(),
        }
    }

    fn run(&self, input: &Map<String, Value>, ctx: &mut Ctx) -> flatbed::Result<ToolResult> {
        let (kind, value) = self
            .behaviour
            .as_object()
            .and_then(|b| b.iter().next())
            .ok_or("A tool's behaviour must be an object with one key.")?;
        match kind.as_str() {
            "echo" => Ok(ToolResult::text(
                match &input[value.as_str().unwrap_or("")] {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                },
            )),
            "text" => Ok(ToolResult::text(value.as_str().unwrap_or(""))),
            "error" => Err(value.as_str().unwrap_or("").into()),
            "reset" => {
                ctx.request_reset(value.as_str().map(String::from));
                Ok(ToolResult::text("Session will reset after this turn."))
            }
            "deliver" => {
                ctx.deliver(serde_json::from_value(value.clone())?);
                Ok(ToolResult::text("Delivered."))
            }
            other => Err(format!("Unknown behaviour {other}.").into()),
        }
    }
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| flatbed::env::repo_root().join("conformance/scenarios"));
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|f| f.expect("a directory entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    let mut failed = 0;
    for file in files {
        let text = std::fs::read_to_string(&file).expect("a readable scenario");
        let scenario: Scenario = match serde_json::from_str(&text) {
            Ok(scenario) => scenario,
            Err(error) => {
                println!("FAIL {}: cannot read the scenario: {error}", file.display());
                failed += 1;
                continue;
            }
        };
        match run(&scenario) {
            Ok(()) => println!("ok {}", scenario.name),
            Err(difference) => {
                println!("FAIL {}: {difference}", scenario.name);
                failed += 1;
            }
        }
    }
    if failed > 0 {
        std::process::exit(1);
    }
}

/// Runs one scenario, and returns the first difference from what it expects.
fn run(scenario: &Scenario) -> Result<(), String> {
    let store = Rc::new(MemoryStore::new());
    // The signal for the current run, which an `abort` step sets mid-call.
    let signal = Rc::new(RefCell::new(StopSignal::new()));
    let script = scenario
        .script
        .iter()
        .map(|step| match step {
            ScriptStep::Response(s) => Script::Response(Scripted {
                content: s.content.clone(),
                usage: s.usage.clone(),
                stop: s.stop,
            }),
            ScriptStep::Abort { abort } => {
                let (signal, who) = (signal.clone(), abort.clone());
                Script::Function(Box::new(move |_| {
                    signal.borrow().stop(who.clone());
                    Err("The request was cancelled.".into())
                }))
            }
        })
        .collect();
    let faux = Rc::new(Faux::new(script));
    let mut config = AgentConfig::new("test", &scenario.agent.model);
    config.soft_limit = scenario.agent.soft_limit.unwrap_or(config.soft_limit);
    config.hard_limit = scenario.agent.hard_limit.unwrap_or(config.hard_limit);
    config.max_tokens = scenario.agent.max_tokens.unwrap_or(config.max_tokens);
    config.plugins.push(Box::new(ScenarioPlugin {
        sections: scenario.sections.clone(),
        tools: scenario.tools.clone(),
        hooks: scenario.plugin.clone(),
    }));
    let providers = HashMap::from([("faux".to_string(), faux.clone() as Rc<dyn Provider>)]);
    let mut agent = Agent::new(config, store.clone(), providers);

    let mut rewind_to: Option<String> = None;
    let mut rewind_targets = Vec::new();
    for (index, step) in scenario.steps.iter().enumerate() {
        let fail = |what: String| format!("step {index}: {what}");
        if let Some(event) = step.get("deliver") {
            let event: Event =
                serde_json::from_value(event.clone()).map_err(|e| fail(e.to_string()))?;
            match rewind_to.take() {
                Some(parent) => agent.deliver_after(event, parent),
                None => agent.deliver(event),
            }
        } else if let Some(options) = step.get("run") {
            let current = StopSignal::new();
            if let Some(who) = options.get("stop").and_then(Value::as_str) {
                current.stop(who);
            }
            *signal.borrow_mut() = current.clone();
            let outcome = agent.run(Some(&current)).map_err(|e| fail(e.to_string()))?;
            if let Some(expected) = step.get("expect").and_then(Value::as_str) {
                if outcome.as_str() != expected {
                    return Err(fail(format!(
                        "expected the run to end {expected}, got {}",
                        outcome.as_str()
                    )));
                }
            }
        } else if let Some(body) = step.get("crash") {
            let body: EntryBody =
                serde_json::from_value(body.clone()).map_err(|e| fail(e.to_string()))?;
            let session = newest(&*store)?;
            let entry = Entry {
                id: flatbed::ids::new_entry_id(),
                parent_id: session.entries.last().map(|e| e.id.clone()),
                at: flatbed::ids::now_iso(),
                body,
            };
            store
                .append("test", &session.header.id, &entry)
                .map_err(|e| fail(e.to_string()))?;
        } else if let Some(index) = step.get("rewind").and_then(Value::as_u64) {
            let session = newest(&*store)?;
            let path = path_of(&session.entries);
            let target = path
                .get(index as usize)
                .ok_or_else(|| fail(format!("the path has no entry {index}")))?;
            rewind_to = Some(target.id.clone());
            rewind_targets.push(target.id.clone());
        } else {
            return Err(fail(format!("unknown step {step}")));
        }
    }

    compare_sessions(&*store, &scenario.expect.sessions, &rewind_targets)?;
    if let Some(expected) = &scenario.expect.requests {
        let actual: Vec<Value> = faux
            .requests()
            .iter()
            .map(|r| serde_json::to_value(&r.messages).expect("messages serialise"))
            .collect();
        difference(
            "requests",
            &Value::Array(expected.clone()),
            &Value::Array(actual),
        )?;
    }
    Ok(())
}

fn newest(store: &dyn Store) -> Result<flatbed::Session, String> {
    let ids = store.list("test").map_err(|e| e.to_string())?;
    let id = ids.last().ok_or("there is no session yet")?;
    store.read("test", id).map_err(|e| e.to_string())
}

fn compare_sessions(
    store: &dyn Store,
    expected: &[Vec<Value>],
    rewind_targets: &[String],
) -> Result<(), String> {
    let ids = store.list("test").map_err(|e| e.to_string())?;
    if ids.len() != expected.len() {
        return Err(format!(
            "expected {} sessions, got {}",
            expected.len(),
            ids.len()
        ));
    }
    for (n, (id, expected)) in ids.iter().zip(expected).enumerate() {
        let session = store.read("test", id).map_err(|e| e.to_string())?;
        let mut expected = expected.as_slice();
        if let Some(header) = expected.first().and_then(|first| first.get("header")) {
            let want = &header["parent"]["reason"];
            let got = session
                .header
                .parent
                .as_ref()
                .map(|p| Value::from(p.reason.clone()));
            if Some(want) != got.as_ref() {
                return Err(format!(
                    "sessions[{n}].header.parent.reason: expected {want}, got {got:?}"
                ));
            }
            expected = &expected[1..];
        }
        let actual: Vec<Value> = session
            .entries
            .iter()
            .map(|entry| {
                let mut value = serde_json::to_value(entry).expect("entries serialise");
                let object = value.as_object_mut().expect("an entry is an object");
                for key in ["id", "parentId", "at"] {
                    object.remove(key);
                }
                value
            })
            .collect();
        difference(
            &format!("sessions[{n}]"),
            &Value::Array(expected.to_vec()),
            &Value::Array(actual),
        )?;
        let mut previous: Option<&str> = None;
        for (i, entry) in session.entries.iter().enumerate() {
            let parent = entry.parent_id.as_deref();
            let rewound = matches!(entry.body, EntryBody::Event(_))
                && parent.is_some_and(|p| rewind_targets.iter().any(|t| t == p));
            if parent != previous && !rewound {
                return Err(format!(
                    "sessions[{n}][{i}].parentId: expected {previous:?}, got {parent:?}"
                ));
            }
            previous = Some(&entry.id);
        }
    }
    Ok(())
}

/// The first place where two JSON values differ, as a path and both values.
fn difference(path: &str, expected: &Value, actual: &Value) -> Result<(), String> {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            for key in want.keys().chain(got.keys()) {
                let (w, g) = (want.get(key), got.get(key));
                match (w, g) {
                    (Some(w), Some(g)) => difference(&format!("{path}.{key}"), w, g)?,
                    _ => return Err(format!("{path}.{key}: expected {w:?}, got {g:?}")),
                }
            }
            Ok(())
        }
        (Value::Array(want), Value::Array(got)) => {
            for (i, (w, g)) in want.iter().zip(got).enumerate() {
                difference(&format!("{path}[{i}]"), w, g)?;
            }
            if want.len() != got.len() {
                let extra = got.get(want.len()).or(want.get(got.len()));
                return Err(format!(
                    "{path}: expected {} items, got {}; first unmatched: {}",
                    want.len(),
                    got.len(),
                    extra.map(Value::to_string).unwrap_or_default()
                ));
            }
            Ok(())
        }
        _ if expected == actual => Ok(()),
        _ => Err(format!("{path}: expected {expected}, got {actual}")),
    }
}
