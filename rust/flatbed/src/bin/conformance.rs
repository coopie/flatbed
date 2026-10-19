//! The conformance runner, as docs/spec/conformance.md describes. It runs every scenario in
//! `conformance/scenarios/` against a memory store with the faux provider, prints `ok <name>` or
//! `FAIL <name>: <first difference>` for each, and exits non-zero on any failure.
//!
//!   cargo run --bin conformance [scenario-dir]

use async_trait::async_trait;
use flatbed::providers::faux::{Faux, Script, Scripted};
use flatbed::render::path_of;
use flatbed::{
    Agent, AgentConfig, Block, Contribution, Ctx, Entry, EntryBody, Event, Header, MemoryStore,
    Message, ParentLink, Plugin, Provider, Section, Session, Stop, StopSignal, Store, Tool,
    ToolCall, ToolDefinition, ToolExecution, ToolResult, Usage,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A scenario that has not finished by then fails, so that a run that never ends cannot hang
/// the suite.
const SCENARIO_TIMEOUT: Duration = Duration::from_secs(10);

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
    effort: Option<String>,
    tool_execution: Option<String>,
    max_concurrent_tools: Option<usize>,
    parent: Option<ParentLink>,
}

/// What the test plugin does beyond giving sections and tools.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hooks {
    /// What the `context` hook does beyond giving sections and tools: try to append, or fail.
    context: Option<OpeningJson>,
    /// A result to use in place of running the named tool.
    before_tool: Option<HashMap<String, ResultJson>>,
    /// A result to replace the named tool's result with.
    after_tool: Option<HashMap<String, ResultJson>>,
    /// Data for a custom entry appended after each tool message, or an error to throw there.
    on_entry: Option<WatchJson>,
    /// An event to deliver when the session ends.
    on_session_end: Option<DeliverJson>,
}

/// A result for a hook to return, or `{"throw": "<message>"}`: make the hook fail with that error.
#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum ResultJson {
    Throw {
        throw: String,
    },
    #[serde(rename_all = "camelCase")]
    Result {
        content: Vec<Block>,
        is_error: bool,
    },
}

impl ResultJson {
    fn result(&self) -> flatbed::Result<ToolResult> {
        match self {
            ResultJson::Throw { throw } => Err(throw.as_str().into()),
            ResultJson::Result { content, is_error } => Ok(ToolResult {
                content: content.clone(),
                is_error: *is_error,
            }),
        }
    }
}

/// `{"append": <data>}`: try to append a custom entry, and carry on when that fails; or
/// `{"throw": "<message>"}`: fail.
#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum OpeningJson {
    Append { append: Value },
    Throw { throw: String },
}

/// `{"custom": <data>}`: append a custom entry; or `{"throw": "<message>"}`: fail, which an
/// `on_entry` hook cannot do in Rust, so it does nothing.
#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum WatchJson {
    Custom {
        custom: Value,
    },
    #[allow(dead_code)]
    Throw {
        throw: String,
    },
}

#[derive(Clone, Deserialize)]
struct DeliverJson {
    deliver: Event,
}

/// A scripted response, or `{"abort": "<who>"}`: set the stop signal while the call is in flight,
/// and fail the call, or `{"hang": true}`: never answer, and ignore the signal.
#[derive(Deserialize)]
#[serde(untagged)]
enum ScriptStep {
    Abort {
        abort: String,
    },
    #[allow(dead_code)]
    Hang {
        hang: bool,
    },
    Response(ScriptedJson),
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioTool {
    name: String,
    description: String,
    input_schema: Value,
    behaviour: Value,
    /// How many calls are running now, and the most there have been at once, for
    /// `expect.maxRunning`.
    #[serde(skip)]
    running: Arc<Running>,
}

#[derive(Default)]
struct Running {
    now: AtomicUsize,
    most: AtomicUsize,
}

#[derive(Deserialize)]
struct ScriptedJson {
    content: Vec<Block>,
    usage: Option<Usage>,
    stop: Option<Stop>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expect {
    sessions: Vec<Vec<Value>>,
    requests: Option<Vec<Value>>,
    max_running: Option<usize>,
}

/// The test plugin: the scenario's sections and tools, from its `context` hook.
struct ScenarioPlugin {
    sections: Vec<Section>,
    tools: Vec<ScenarioTool>,
    hooks: Hooks,
}

#[async_trait]
impl Plugin for ScenarioPlugin {
    fn name(&self) -> &str {
        "test"
    }

    async fn context(&self, ctx: &Ctx) -> flatbed::Result<Contribution> {
        match &self.hooks.context {
            Some(OpeningJson::Throw { throw }) => return Err(throw.as_str().into()),
            // `append` fails here, and the hook carries on.
            Some(OpeningJson::Append { append }) => {
                let _ = ctx.append("test", append.clone()).await;
            }
            None => {}
        }
        Ok(Contribution {
            sections: self.sections.clone(),
            tools: self
                .tools
                .iter()
                .map(|tool| Box::new(tool.clone()) as Box<dyn Tool>)
                .collect(),
        })
    }

    async fn before_tool(
        &self,
        call: &ToolCall,
        _ctx: &Ctx,
    ) -> flatbed::Result<Option<ToolResult>> {
        let found = self
            .hooks
            .before_tool
            .as_ref()
            .and_then(|by_name| by_name.get(&call.name));
        found.map(ResultJson::result).transpose()
    }

    async fn after_tool(
        &self,
        call: &ToolCall,
        result: ToolResult,
        _ctx: &Ctx,
    ) -> flatbed::Result<ToolResult> {
        let found = self
            .hooks
            .after_tool
            .as_ref()
            .and_then(|by_name| by_name.get(&call.name));
        found.map(ResultJson::result).unwrap_or(Ok(result))
    }

    async fn on_entry(&self, entry: &Entry, ctx: &Ctx) {
        let is_result = matches!(
            &entry.body,
            EntryBody::Message {
                message: Message::Tool(_)
            }
        );
        if let (Some(WatchJson::Custom { custom }), true) = (&self.hooks.on_entry, is_result) {
            ctx.append("test", custom.clone())
                .await
                .expect("the session is open");
        }
    }

    async fn on_session_end(&self, _session: &Session, ctx: &Ctx) {
        if let Some(hook) = &self.hooks.on_session_end {
            ctx.deliver(hook.deliver.clone());
        }
    }
}

#[async_trait]
impl Tool for ScenarioTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema: self.input_schema.clone(),
        }
    }

    async fn run(&self, input: &Map<String, Value>, ctx: &Ctx) -> flatbed::Result<ToolResult> {
        let running = self.running.now.fetch_add(1, Ordering::SeqCst) + 1;
        self.running.most.fetch_max(running, Ordering::SeqCst);
        let result = self.behave(input, ctx).await;
        self.running.now.fetch_sub(1, Ordering::SeqCst);
        result
    }
}

impl ScenarioTool {
    async fn behave(&self, input: &Map<String, Value>, ctx: &Ctx) -> flatbed::Result<ToolResult> {
        let behaviour = self.behaviour.as_object();
        let text = |key: &str| {
            let value = behaviour.and_then(|b| b.get(key)).and_then(Value::as_str);
            value.unwrap_or_default().to_string()
        };
        // Any behaviour may wait first, then append, then do the rest.
        if let Some(ms) = behaviour
            .and_then(|b| b.get("sleep"))
            .and_then(Value::as_u64)
        {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        if let Some(data) = behaviour.and_then(|b| b.get("append")) {
            ctx.append("test", data.clone()).await?;
        }
        let (kind, value) = behaviour
            .and_then(|b| {
                b.iter()
                    .find(|(key, _)| *key != "sleep" && *key != "append")
            })
            .ok_or("A tool's behaviour must say what the tool does.")?;
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
            "waitForStop" => {
                ctx.signal().wait().await;
                Ok(ToolResult::text(text("waitForStop")))
            }
            "runTools" => {
                // The tool gives up its place while its calls run, so it does not count as running
                // then.
                self.running.now.fetch_sub(1, Ordering::SeqCst);
                let calls = value.as_array().cloned().unwrap_or_default();
                let results =
                    futures_util::future::join_all(calls.into_iter().enumerate().map(|(i, c)| {
                        ctx.run_tool(ToolCall {
                            id: format!("nested-{i}"),
                            name: c["name"].as_str().unwrap_or_default().to_string(),
                            input: c["input"].clone(),
                        })
                    }))
                    .await;
                let running = self.running.now.fetch_add(1, Ordering::SeqCst) + 1;
                self.running.most.fetch_max(running, Ordering::SeqCst);
                let texts: Vec<String> = results
                    .iter()
                    .map(|r| {
                        r.content
                            .iter()
                            .filter_map(|b| match b {
                                Block::Text { text } => Some(text.as_str()),
                                _ => None,
                            })
                            .collect()
                    })
                    .collect();
                Ok(ToolResult::text(texts.join("\n")))
            }
            "deliver" => {
                ctx.deliver(serde_json::from_value(value.clone())?);
                Ok(ToolResult::text("Delivered."))
            }
            other => Err(format!("Unknown behaviour {other}.").into()),
        }
    }
}

#[tokio::main]
async fn main() {
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
        let outcome = tokio::time::timeout(SCENARIO_TIMEOUT, run(&scenario))
            .await
            .unwrap_or_else(|_| Err(format!("not finished after {SCENARIO_TIMEOUT:?}")));
        match outcome {
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

/// The agent the scenario describes, with the test plugin and the faux provider.
fn agent(
    scenario: &Scenario,
    store: Arc<MemoryStore>,
    faux: Arc<Faux>,
    running: Arc<Running>,
) -> flatbed::Result<Agent> {
    let given = &scenario.agent;
    let mut config = AgentConfig::new("test", &given.model);
    config.soft_limit = given.soft_limit.unwrap_or(config.soft_limit);
    config.hard_limit = given.hard_limit.unwrap_or(config.hard_limit);
    config.max_tokens = given.max_tokens.unwrap_or(config.max_tokens);
    config.effort = given.effort.clone();
    config.tool_execution = match given.tool_execution.as_deref() {
        None | Some("concurrent") => ToolExecution::Concurrent,
        Some("serial") => ToolExecution::Serial,
        Some(other) => return Err(format!("Unknown toolExecution {other}.").into()),
    };
    config.max_concurrent_tools = given
        .max_concurrent_tools
        .unwrap_or(config.max_concurrent_tools);
    config.parent = given.parent.clone();
    let tools = scenario.tools.iter().map(|tool| ScenarioTool {
        running: running.clone(),
        ..tool.clone()
    });
    config.plugins.push(Box::new(ScenarioPlugin {
        sections: scenario.sections.clone(),
        tools: tools.collect(),
        hooks: scenario.plugin.clone(),
    }));
    let providers = HashMap::from([("faux".to_string(), faux as Arc<dyn Provider>)]);
    Agent::new(config, store, providers)
}

/// Runs one scenario, and returns the first difference from what it expects.
async fn run(scenario: &Scenario) -> Result<(), String> {
    let store = Arc::new(MemoryStore::new());
    // The signal for the current run, which an `abort` step sets mid-call.
    let signal = Arc::new(Mutex::new(StopSignal::new()));
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
                    signal.lock().unwrap().set(who.clone());
                    Box::pin(async { Err("The request was cancelled.".into()) })
                }))
            }
            ScriptStep::Hang { .. } => {
                Script::Function(Box::new(|_| Box::pin(std::future::pending())))
            }
        })
        .collect();
    let faux = Arc::new(Faux::new(script));
    let running = Arc::new(Running::default());
    let agent =
        agent(scenario, store.clone(), faux.clone(), running.clone()).map_err(|e| e.to_string())?;

    let mut rewind_to: Option<String> = None;
    let mut rewind_targets = Vec::new();
    for (index, step) in scenario.steps.iter().enumerate() {
        let fail = |what: String| format!("step {index}: {what}");
        if let Some(event) = step.get("deliver") {
            let event: Event =
                serde_json::from_value(event.clone()).map_err(|e| fail(e.to_string()))?;
            agent.deliver(event, rewind_to.take());
        } else if let Some(options) = step.get("run") {
            let current = StopSignal::new();
            *signal.lock().unwrap() = current.clone();
            if let Some(who) = options.get("stop").and_then(Value::as_str) {
                match options.get("stopAfter").and_then(Value::as_u64) {
                    Some(ms) => {
                        let (current, who) = (current.clone(), who.to_string());
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(ms)).await;
                            current.set(who);
                        });
                    }
                    None => current.set(who),
                }
            }
            let outcome = match agent.run(Some(&current)).await {
                Ok(outcome) => json!(outcome.as_str()),
                Err(error) => json!({"error": error.to_string()}),
            };
            match step.get("expect") {
                Some(expected) if *expected != outcome => {
                    return Err(fail(format!(
                        "expected the run to end {expected}, got {outcome}"
                    )))
                }
                None if outcome.get("error").is_some() => {
                    return Err(fail(format!("the run failed: {outcome}")))
                }
                _ => {}
            }
        } else if let Some(body) = step.get("crash") {
            let body: EntryBody =
                serde_json::from_value(body.clone()).map_err(|e| fail(e.to_string()))?;
            let session = newest(&*store).await?;
            let entry = Entry {
                id: flatbed::ids::new_entry_id(),
                parent_id: session.entries.last().map(|e| e.id.clone()),
                at: flatbed::ids::now_iso(),
                body,
            };
            store
                .append("test", &session.header.id, &entry)
                .await
                .map_err(|e| fail(e.to_string()))?;
        } else if step.get("header").is_some() {
            // Only the header of a new session, as a process that stopped before its context
            // entry would leave.
            let ids = store.list("test").await.map_err(|e| fail(e.to_string()))?;
            let now = flatbed::ids::now_iso();
            let header = Header {
                version: 1,
                id: flatbed::ids::new_session_id(&now, ids.last().map(String::as_str))
                    .map_err(|e| fail(e.to_string()))?,
                agent: "test".into(),
                created_at: now,
                parent: ids.last().map(|previous| ParentLink {
                    session: previous.clone(),
                    reason: "reset".into(),
                    entry: None,
                    agent: None,
                }),
            };
            store
                .create(&header)
                .await
                .map_err(|e| fail(e.to_string()))?;
        } else if let Some(index) = step.get("rewind").and_then(Value::as_u64) {
            let session = newest(&*store).await?;
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

    compare_sessions(&*store, &scenario.expect.sessions, &rewind_targets).await?;
    if let Some(expected) = &scenario.expect.requests {
        compare_requests(expected, &faux.requests())?;
    }
    if let Some(expected) = scenario.expect.max_running {
        let most = running.most.load(Ordering::SeqCst);
        if most != expected {
            return Err(format!("maxRunning: expected {expected}, got {most}"));
        }
    }
    Ok(())
}

/// Each expected request is either its messages, or an object with any of `messages`,
/// `sections`, `tools`, `maxTokens` and `effort`.
fn compare_requests(expected: &[Value], actual: &[flatbed::Request]) -> Result<(), String> {
    if expected.len() != actual.len() {
        return Err(format!(
            "requests: expected {} requests, got {}",
            expected.len(),
            actual.len()
        ));
    }
    for (n, (want, got)) in expected.iter().zip(actual).enumerate() {
        let got = json!({
            "messages": got.messages,
            "sections": got.sections,
            "tools": got.tools,
            "maxTokens": got.max_tokens,
            "effort": got.effort,
        });
        let Some(want) = want.as_object() else {
            difference(&format!("requests[{n}]"), want, &got["messages"])?;
            continue;
        };
        for (key, want) in want {
            difference(&format!("requests[{n}].{key}"), want, &got[key])?;
        }
    }
    Ok(())
}

async fn newest(store: &dyn Store) -> Result<flatbed::Session, String> {
    let ids = store.list("test").await.map_err(|e| e.to_string())?;
    let id = ids.last().ok_or("there is no session yet")?;
    store.read("test", id).await.map_err(|e| e.to_string())
}

async fn compare_sessions(
    store: &dyn Store,
    expected: &[Vec<Value>],
    rewind_targets: &[String],
) -> Result<(), String> {
    let ids = store.list("test").await.map_err(|e| e.to_string())?;
    if ids.len() != expected.len() {
        return Err(format!(
            "expected {} sessions, got {}",
            expected.len(),
            ids.len()
        ));
    }
    for (n, (id, expected)) in ids.iter().zip(expected).enumerate() {
        let session = store.read("test", id).await.map_err(|e| e.to_string())?;
        let mut expected = expected.as_slice();
        if let Some(header) = expected.first().and_then(|first| first.get("header")) {
            let want = &header["parent"];
            let mut got =
                serde_json::to_value(&session.header.parent).expect("a parent serialises");
            // A scenario cannot know the id of a session the loop made, so it may leave it out.
            if let (Some(got), None) = (got.as_object_mut(), want.get("session")) {
                got.remove("session");
            }
            difference(&format!("sessions[{n}].header.parent"), want, &got)?;
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
