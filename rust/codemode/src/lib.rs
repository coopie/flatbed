//! Codemode: a `run_script` tool that lets the model write a short Python script which calls
//! several of the agent's tools and returns only what it needs, in one turn.
//!
//! The script runs in Monty inside the shared worker process in `codemode/` at the repo root; this
//! crate starts that process and speaks the JSON-lines protocol in docs/codemode.md to it. The
//! TypeScript package's README, ts/packages/codemode/README.md, explains the idea.

use async_trait::async_trait;
use flatbed::{
    Block, Contribution, Ctx, Entry, EntryBody, Error, Plugin, Result, Session, Tool, ToolCall,
    ToolDefinition, ToolExecution, ToolResult,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub const DEFAULT_MAX_CALLS: usize = 25;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const NOT_RUN: &str = "The harness stopped before this tool ran.";

pub struct CodemodeOptions {
    /// The tools a script may call, by name. A script cannot call any other tool.
    pub tools: Vec<String>,
    /// The most tool calls one script may make.
    pub max_calls: usize,
    /// How long one script may run, tool calls included.
    pub timeout: Duration,
    /// The most heap memory the script may use, in bytes. 64 MB when not set.
    pub max_memory: Option<u64>,
    /// A fixed time for the script's clock, as ISO 8601, for replay tests. The real clock when not set.
    pub start_time: Option<String>,
    /// How to start the worker. `uv run` on `codemode/worker.py` when not set.
    pub worker: Option<Vec<String>>,
}

impl CodemodeOptions {
    pub fn new(tools: impl IntoIterator<Item = impl Into<String>>) -> CodemodeOptions {
        CodemodeOptions {
            tools: tools.into_iter().map(Into::into).collect(),
            max_calls: DEFAULT_MAX_CALLS,
            timeout: DEFAULT_TIMEOUT,
            max_memory: None,
            start_time: None,
            worker: None,
        }
    }
}

/// `uv run` in the worker's own project, so that its one dependency stays its own.
pub fn default_worker() -> Vec<String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../codemode");
    let dir = dir.canonicalize().unwrap_or(dir);
    let project = dir.display().to_string();
    let worker = dir.join("worker.py").display().to_string();
    [
        "uv",
        "run",
        "--quiet",
        "--frozen",
        "--project",
        &project,
        "python",
        &worker,
    ]
    .map(String::from)
    .to_vec()
}

type Code = Arc<Mutex<HashMap<String, Arc<dyn Tool>>>>;

/// Adds codemode to a list of plugins. It returns the plugins with their `context` hooks wrapped,
/// so that codemode can find the code for the tools they add, followed by the codemode plugin.
///
/// The wrapping is a stopgap: the core gives a tool no way to run another call through the loop's
/// own runner, so codemode runs nested calls itself, the same way, with the agent's plugins' hooks.
pub fn with_codemode(
    plugins: Vec<Box<dyn Plugin>>,
    options: CodemodeOptions,
) -> Vec<Box<dyn Plugin>> {
    let code = Code::default();
    let mut wrapped: Vec<Box<dyn Plugin>> = plugins
        .into_iter()
        .map(|inner| {
            Box::new(Capturing {
                inner,
                code: code.clone(),
            }) as Box<dyn Plugin>
        })
        .collect();
    wrapped.push(Box::new(Codemode {
        code,
        options: Arc::new(options),
    }));
    wrapped
}

/// A plugin as it was, except that its `context` hook records the code of the tools it adds.
struct Capturing {
    inner: Box<dyn Plugin>,
    code: Code,
}

/// A tool whose code codemode shares with the loop.
struct Shared(Arc<dyn Tool>);

#[async_trait]
impl Tool for Shared {
    fn definition(&self) -> ToolDefinition {
        self.0.definition()
    }
    async fn run(&self, input: &Map<String, Value>, ctx: &Ctx) -> Result<ToolResult> {
        self.0.run(input, ctx).await
    }
}

#[async_trait]
impl Plugin for Capturing {
    fn name(&self) -> &str {
        self.inner.name()
    }
    async fn context(&self, ctx: &Ctx) -> Result<Contribution> {
        let added = self.inner.context(ctx).await?;
        let mut code = self.code.lock().expect("codemode lock");
        let tools = added
            .tools
            .into_iter()
            .map(|tool| {
                let tool: Arc<dyn Tool> = Arc::from(tool);
                code.insert(tool.definition().name, tool.clone());
                Box::new(Shared(tool)) as Box<dyn Tool>
            })
            .collect();
        Ok(Contribution {
            sections: added.sections,
            tools,
        })
    }
    async fn before_tool(&self, call: &ToolCall, ctx: &Ctx) -> Result<Option<ToolResult>> {
        self.inner.before_tool(call, ctx).await
    }
    async fn after_tool(
        &self,
        call: &ToolCall,
        result: ToolResult,
        ctx: &Ctx,
    ) -> Result<ToolResult> {
        self.inner.after_tool(call, result, ctx).await
    }
    async fn on_entry(&self, entry: &Entry, ctx: &Ctx) {
        self.inner.on_entry(entry, ctx).await
    }
    async fn on_session_end(&self, session: &Session, ctx: &Ctx) {
        self.inner.on_session_end(session, ctx).await
    }
}

struct Codemode {
    code: Code,
    options: Arc<CodemodeOptions>,
}

#[async_trait]
impl Plugin for Codemode {
    fn name(&self) -> &str {
        "codemode"
    }
    async fn context(&self, _ctx: &Ctx) -> Result<Contribution> {
        let code = self.code.lock().expect("codemode lock").clone();
        let callable = self
            .options
            .tools
            .iter()
            .filter_map(|name| code.get(name).map(|tool| tool.definition()))
            .collect();
        Ok(Contribution {
            sections: Vec::new(),
            tools: vec![Box::new(RunScript {
                callable,
                code: Arc::new(code),
                options: self.options.clone(),
            })],
        })
    }
}

struct RunScript {
    callable: Vec<ToolDefinition>,
    code: Arc<HashMap<String, Arc<dyn Tool>>>,
    options: Arc<CodemodeOptions>,
}

#[async_trait]
impl Tool for RunScript {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "run_script".into(),
            description: describe(&self.callable, self.options.max_calls, self.options.timeout),
            input_schema: json!({"type": "object", "properties": {"script": {"type": "string"}}, "required": ["script"]}),
        }
    }

    async fn run(&self, input: &Map<String, Value>, ctx: &Ctx) -> Result<ToolResult> {
        let script = input
            .get("script")
            .and_then(Value::as_str)
            .unwrap_or_default();
        Ok(self.run_script(script, ctx).await)
    }
}

/// The tool's description: what a script is for, its limits, and the tools as Python signatures.
pub fn describe(tools: &[ToolDefinition], max_calls: usize, timeout: Duration) -> String {
    let signatures = tools.iter().map(signature).collect::<Vec<_>>().join("\n\n");
    let signatures = if signatures.is_empty() {
        "# None.".to_string()
    } else {
        signatures
    };
    [
        "Run a short Python script that calls your tools, and get back what it prints and the value of its last line.".to_string(),
        "Use it when a task needs several tool calls and you need only part of their results, such as reading several documents to find one fact.".into(),
        "The script runs in a sandboxed subset of Python with no files, environment or network.".into(),
        "Each tool below is an async function: await it, and use asyncio.gather to run calls at the same time.".into(),
        "A tool returns its result as text, and raises RuntimeError with its message when it fails.".into(),
        format!("A script may make at most {max_calls} tool calls and run for at most {} seconds.", timeout.as_secs_f64().round()),
        String::new(),
        "The tools a script can call:".into(),
        String::new(),
        "```python".into(),
        signatures,
        "```".into(),
    ]
    .join("\n")
}

/// A tool as a Python signature, required parameters first, with its description as the docstring.
pub fn signature(tool: &ToolDefinition) -> String {
    let (required, optional) = params(tool);
    let properties = tool.input_schema.get("properties");
    let typed = |name: &String| {
        let kind = properties
            .and_then(|p| p.get(name))
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let py = match kind {
            "string" => "str",
            "integer" => "int",
            "number" => "float",
            "boolean" => "bool",
            "array" => "list",
            "object" => "dict",
            _ => "object",
        };
        format!("{name}: {py}")
    };
    let args = required
        .iter()
        .map(typed)
        .chain(optional.iter().map(|n| format!("{} = None", typed(n))))
        .collect::<Vec<_>>()
        .join(", ");
    let doc = tool.description.replace("\"\"\"", "\\\"\\\"\\\"");
    format!(
        "async def {}({args}) -> str:\n    \"\"\"{doc}\"\"\"",
        tool.name
    )
}

fn params(tool: &ToolDefinition) -> (Vec<String>, Vec<String>) {
    let names: Vec<String> = tool
        .input_schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default();
    let required: Vec<&str> = tool
        .input_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    names
        .into_iter()
        .partition(|n| required.contains(&n.as_str()))
}

fn text_result(text: impl Into<String>) -> ToolResult {
    ToolResult::text(text)
}

fn text_of(result: &ToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// What the script printed, then its value or error on a line of its own.
fn joined(output: &str, last: Option<&str>) -> String {
    [
        output.strip_suffix('\n').unwrap_or(output),
        last.unwrap_or(""),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

/// Ends the worker's process group, which holds Monty's interpreter process too.
fn kill_group(child: &mut Child) {
    if let Some(pid) = child.id() {
        // SAFETY: `kill` takes plain integers and has no memory effects.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
}

impl RunScript {
    /// Runs one script in a fresh worker process, answering its calls, until it ends or a limit
    /// ends it.
    async fn run_script(&self, script: &str, ctx: &Ctx) -> ToolResult {
        let command = self.options.worker.clone().unwrap_or_else(default_worker);
        let mut builder = Command::new(&command[0]);
        builder
            .args(&command[1..])
            // An empty environment but for what `uv` needs to find itself and its cache: no keys
            // reach the worker.
            .env_clear()
            .envs(
                ["PATH", "HOME"]
                    .iter()
                    .filter_map(|k| std::env::var(k).ok().map(|v| (*k, v))),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Its own process group, so that ending it ends Monty's interpreter process too.
            .process_group(0)
            .kill_on_drop(true);
        let mut child = match builder.spawn() {
            Ok(child) => child,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return ToolResult::error(format!(
                    "The codemode worker could not start: {} was not found.",
                    command[0]
                ))
            }
            Err(e) => return ToolResult::error(format!("The codemode worker failed: {e}")),
        };
        let result = tokio::select! {
            result = self.talk(script, &mut child, ctx) => result,
            _ = ctx.signal().wait() => ToolResult::error("The harness stopped this script."),
            _ = tokio::time::sleep(self.options.timeout) => ToolResult::error(format!(
                "The script ran for more than {} seconds, so it was stopped.",
                self.options.timeout.as_secs_f64()
            )),
        };
        drop(child.stdin.take());
        kill_group(&mut child);
        let _ = child.wait().await;
        result
    }

    async fn talk(&self, script: &str, child: &mut Child, ctx: &Ctx) -> ToolResult {
        let mut stdin = child.stdin.take().expect("piped stdin");
        let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let mut stderr = child.stderr.take().expect("piped stderr");
        let script_id = flatbed::ids::new_entry_id();
        let slots = Arc::new(Semaphore::new(match ctx.agent().tool_execution {
            ToolExecution::Serial => 1,
            ToolExecution::Concurrent => ctx.agent().max_concurrent_tools,
        }));
        // The schemas the session's context entry froze, as the loop checks them.
        let frozen: Arc<HashMap<String, Value>> = Arc::new(
            ctx.session()
                .await
                .entries
                .iter()
                .find_map(|e| match &e.body {
                    EntryBody::Context { tools, .. } => Some(tools.clone()),
                    _ => None,
                })
                .unwrap_or_default()
                .into_iter()
                .map(|t| (t.name, t.input_schema))
                .collect(),
        );

        let mut start = json!({
            "type": "start",
            "script": script,
            "tools": self.callable.iter().map(|t| {
                let (required, optional) = params(t);
                let names = [required, optional].concat();
                json!({"name": t.name, "params": names})
            }).collect::<Vec<_>>(),
            "timeoutMs": self.options.timeout.as_millis() as u64,
        });
        if let Some(memory) = self.options.max_memory {
            start["maxMemory"] = json!(memory);
        }
        if let Some(time) = &self.options.start_time {
            start["startTime"] = json!(time);
        }
        if let Err(e) = send(&mut stdin, &start).await {
            return ToolResult::error(format!("The codemode worker failed: {e}"));
        }

        let mut calls = 0;
        let mut answering: JoinSet<(String, ToolCall, ToolResult)> = JoinSet::new();
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let line = match line {
                        Ok(Some(line)) => line,
                        _ => {
                            let mut text = String::new();
                            let _ = stderr.read_to_string(&mut text).await;
                            let text = text.trim();
                            let tail = &text[text.len().saturating_sub(2000)..];
                            let mut message = "The codemode worker ended without finishing the script.".to_string();
                            if !tail.is_empty() {
                                message = format!("{message}\n{tail}");
                            }
                            return ToolResult::error(message);
                        }
                    };
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        return ToolResult::error(format!("The codemode worker sent a line that is not JSON: {line}"));
                    };
                    let field = |name: &str| message.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
                    match field("type").as_str() {
                        "done" => {
                            let text = joined(&field("output"), message.get("value").and_then(Value::as_str));
                            return text_result(if text.is_empty() { "The script returned nothing.".into() } else { text });
                        }
                        "error" => return ToolResult::error(joined(&field("output"), Some(&field("error")))),
                        "call" => {
                            calls += 1;
                            if calls > self.options.max_calls {
                                return ToolResult::error(format!(
                                    "The script made more than {} tool calls, so it was stopped.",
                                    self.options.max_calls
                                ));
                            }
                            let id = field("id");
                            let call = ToolCall {
                                id: format!("{script_id}-{id}"),
                                name: field("name"),
                                input: message.get("input").cloned().unwrap_or(json!({})),
                            };
                            let (slots, frozen, code, ctx) = (slots.clone(), frozen.clone(), self.code.clone(), ctx.clone());
                            let allowed = self.options.tools.contains(&call.name);
                            answering.spawn(async move {
                                let _slot = slots.acquire_owned().await;
                                let result = if ctx.signal().is_set() {
                                    ToolResult::error(NOT_RUN)
                                } else {
                                    run_nested(&call, allowed, &code, &frozen, &ctx).await
                                };
                                (id, call, result)
                            });
                        }
                        _ => {}
                    }
                }
                Some(Ok((id, call, result))) = answering.join_next() => {
                    let data = json!({"call": call, "result": {"content": result.content, "isError": result.is_error}});
                    let _ = ctx.append("codemode", data).await;
                    let reply = json!({"type": "result", "id": id, "text": text_of(&result), "isError": result.is_error});
                    if send(&mut stdin, &reply).await.is_err() {
                        // The worker has gone; the next read says so.
                    }
                }
            }
        }
    }
}

async fn send(stdin: &mut tokio::process::ChildStdin, message: &Value) -> std::io::Result<()> {
    stdin.write_all(format!("{message}\n").as_bytes()).await?;
    stdin.flush().await
}

/// Runs one nested call as docs/spec/plugins.md describes for a direct call. A name off the
/// allow-list is as unknown as a name nobody has.
async fn run_nested(
    call: &ToolCall,
    allowed: bool,
    code: &HashMap<String, Arc<dyn Tool>>,
    frozen: &HashMap<String, Value>,
    ctx: &Ctx,
) -> ToolResult {
    let (Some(tool), Some(schema), true) = (code.get(&call.name), frozen.get(&call.name), allowed)
    else {
        return ToolResult::error(format!("No tool named {}.", call.name));
    };
    let input = match check_input(&call.input, schema) {
        Ok(input) => input,
        Err(problem) => {
            return ToolResult::error(format!("Invalid input for {}: {problem}.", call.name))
        }
    };
    let plugins = &ctx.agent().plugins;
    let mut result = None;
    for plugin in plugins {
        match plugin.before_tool(call, ctx).await {
            Ok(Some(replaced)) => {
                result = Some(replaced);
                break;
            }
            Ok(None) => {}
            Err(e) => return plugin_failed(plugin.name(), e),
        }
    }
    let mut result = match result {
        Some(result) => result,
        None => tool
            .run(input, ctx)
            .await
            .unwrap_or_else(|e| ToolResult::error(e.to_string())),
    };
    for plugin in plugins {
        result = match plugin.after_tool(call, result, ctx).await {
            Ok(result) => result,
            Err(e) => return plugin_failed(plugin.name(), e),
        };
    }
    result
}

fn plugin_failed(name: &str, error: Error) -> ToolResult {
    ToolResult::error(format!("The {name} plugin failed: {error}"))
}

/// The least check the spec asks for: an object, with its required properties present.
fn check_input<'i>(
    input: &'i Value,
    schema: &Value,
) -> std::result::Result<&'i Map<String, Value>, String> {
    let Some(object) = input.as_object() else {
        return Err("expected an object".into());
    };
    let required = schema.get("required").and_then(Value::as_array);
    for name in required.into_iter().flatten().filter_map(Value::as_str) {
        if !object.contains_key(name) {
            return Err(format!("missing required property \"{name}\""));
        }
    }
    Ok(object)
}
