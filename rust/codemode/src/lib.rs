//! Codemode: a `run_script` tool that lets the model write a short Python script which calls
//! several of the agent's tools and returns only what it needs, in one turn.
//!
//! The script runs in Monty inside the shared worker process in `codemode/` at the repo root; this
//! crate starts that process and speaks the JSON-lines protocol in docs/codemode.md to it. The
//! TypeScript package's README, ts/packages/codemode/README.md, explains the idea.

use async_trait::async_trait;
use flatbed::{
    Block, Contribution, Ctx, Entry, Plugin, Result, Session, Tool, ToolCall, ToolDefinition,
    ToolResult,
};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

pub const DEFAULT_MAX_CALLS: usize = 25;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

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

/// The tools the other plugins added, by name, as codemode saw them when the session opened.
type Seen = Arc<Mutex<HashMap<String, ToolDefinition>>>;

/// Adds codemode to a list of plugins. It returns the plugins with their `context` hooks wrapped,
/// so that codemode can see the tools they add, followed by the codemode plugin.
///
/// Codemode needs the allowed tools' descriptions and schemas to write `run_script`'s description,
/// and a `context` hook sees nothing of the tools other plugins add. The calls themselves run
/// through the core, with `Ctx::run_tool`.
pub fn with_codemode(
    plugins: Vec<Box<dyn Plugin>>,
    options: CodemodeOptions,
) -> Vec<Box<dyn Plugin>> {
    let seen = Seen::default();
    let mut wrapped: Vec<Box<dyn Plugin>> = plugins
        .into_iter()
        .map(|inner| {
            Box::new(Watched {
                inner,
                seen: seen.clone(),
            }) as Box<dyn Plugin>
        })
        .collect();
    wrapped.push(Box::new(Codemode {
        seen,
        options: Arc::new(options),
    }));
    wrapped
}

/// A plugin as it was, except that its `context` hook records the tools it adds.
struct Watched {
    inner: Box<dyn Plugin>,
    seen: Seen,
}

#[async_trait]
impl Plugin for Watched {
    fn name(&self) -> &str {
        self.inner.name()
    }
    async fn context(&self, ctx: &Ctx) -> Result<Contribution> {
        let added = self.inner.context(ctx).await?;
        let mut seen = self.seen.lock().expect("codemode lock");
        for tool in &added.tools {
            let definition = tool.definition();
            seen.insert(definition.name.clone(), definition);
        }
        Ok(added)
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
    seen: Seen,
    options: Arc<CodemodeOptions>,
}

#[async_trait]
impl Plugin for Codemode {
    fn name(&self) -> &str {
        "codemode"
    }
    async fn context(&self, _ctx: &Ctx) -> Result<Contribution> {
        let seen = self.seen.lock().expect("codemode lock");
        let callable: Vec<ToolDefinition> = (self.options.tools.iter())
            .filter_map(|name| seen.get(name).cloned())
            .collect();
        Ok(Contribution {
            tools: vec![Box::new(RunScript {
                // Checked here as well as in the worker, so that a worker that misbehaves still
                // reaches only these.
                allowed: Arc::new(callable.iter().map(|t| t.name.clone()).collect()),
                callable,
                options: self.options.clone(),
            })],
            ..Contribution::default()
        })
    }
}

struct RunScript {
    callable: Vec<ToolDefinition>,
    allowed: Arc<HashSet<String>>,
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

/// The most bytes in one message to or from the worker, not counting its newline.
/// docs/codemode.md explains why.
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Ends the worker's process group, which holds Monty's interpreter process too.
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: `kill` takes plain integers and has no memory effects.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

/// A line from the worker's stdout, as the reader saw it.
enum Line {
    Text(Vec<u8>),
    TooLong,
}

/// Reads stdout a line at a time, never holding more than a line at the cap, until it closes or
/// a line passes the cap.
async fn read_lines(stdout: ChildStdout, lines: mpsc::Sender<Line>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = Vec::new();
        // The cap, a newline, and one byte more to tell a line at the cap from a longer one.
        let read = (&mut reader)
            .take(MAX_MESSAGE_BYTES as u64 + 2)
            .read_until(b'\n', &mut line)
            .await;
        if !matches!(read, Ok(n) if n > 0) {
            return;
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.len() > MAX_MESSAGE_BYTES {
            let _ = lines.send(Line::TooLong).await;
            return;
        }
        if lines.send(Line::Text(line)).await.is_err() {
            return;
        }
    }
}

/// Keeps the last 2,000 characters of stderr, read as they come, so that a worker that writes a
/// lot there cannot block on a full pipe.
async fn read_stderr(mut stderr: ChildStderr, tail: Arc<Mutex<String>>) {
    let mut chunk = [0u8; 4096];
    while let Ok(n) = stderr.read(&mut chunk).await {
        if n == 0 {
            return;
        }
        let mut tail = tail.lock().expect("codemode lock");
        tail.push_str(&String::from_utf8_lossy(&chunk[..n]));
        if tail.len() > 2000 {
            let mut cut = tail.len() - 2000;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
    }
}

/// The `result` message for a call, or an error in its place when it would pass the cap.
fn reply(id: &str, call: &ToolCall, result: &ToolResult) -> String {
    let line =
        json!({"type": "result", "id": id, "text": text_of(result), "isError": result.is_error})
            .to_string();
    if line.len() <= MAX_MESSAGE_BYTES {
        return line;
    }
    let text = format!(
        "The result of {} is larger than the {MAX_MESSAGE_BYTES}-byte limit for a message.",
        call.name
    );
    json!({"type": "result", "id": id, "text": text, "isError": true}).to_string()
}

/// The first 200 characters of a line, for an error that quotes it.
fn quote(line: &[u8]) -> String {
    String::from_utf8_lossy(line).chars().take(200).collect()
}

impl RunScript {
    /// Runs one script in a fresh worker process, answering its calls, until it ends or a limit
    /// ends it.
    async fn run_script(&self, script: &str, ctx: &Ctx) -> ToolResult {
        if ctx.signal().is_set() {
            return ToolResult::error("The harness stopped this script.");
        }
        let start = self.start(script).to_string();
        if start.len() > MAX_MESSAGE_BYTES {
            return ToolResult::error(format!(
                "The script is too long: a message to the worker may be at most {MAX_MESSAGE_BYTES} bytes."
            ));
        }
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
        let pid = child.id();
        let stdin = child.stdin.take().expect("piped stdin");
        let (line_tx, lines) = mpsc::channel(1);
        tokio::spawn(read_lines(
            child.stdout.take().expect("piped stdout"),
            line_tx,
        ));
        let tail = Arc::new(Mutex::new(String::new()));
        let mut stderr = tokio::spawn(read_stderr(
            child.stderr.take().expect("piped stderr"),
            tail.clone(),
        ));

        // The calls the host has started, which run to their end even when the script ends first.
        let mut started = JoinSet::new();
        let talk = Talk {
            run_script: self,
            ctx,
            pid,
            stdin,
            lines,
            stderr: &mut stderr,
            tail: &tail,
            started: &mut started,
        };
        let result = tokio::select! {
            result = talk.run(start) => result,
            _ = ctx.signal().wait() => ToolResult::error("The harness stopped this script."),
            _ = tokio::time::sleep(self.options.timeout) => ToolResult::error(format!(
                "The script ran for more than {} seconds, so it was stopped.",
                self.options.timeout.as_secs_f64()
            )),
        };
        kill_group(pid);
        let _ = child.start_kill();
        let _ = child.wait().await;
        stderr.abort();
        // So that their results are recorded and the turn's limit holds, as docs/codemode.md
        // describes.
        while started.join_next().await.is_some() {}
        result
    }

    fn start(&self, script: &str) -> Value {
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
        start
    }
}

/// One script's conversation with its worker.
struct Talk<'a> {
    run_script: &'a RunScript,
    ctx: &'a Ctx,
    pid: Option<u32>,
    stdin: ChildStdin,
    lines: mpsc::Receiver<Line>,
    stderr: &'a mut tokio::task::JoinHandle<()>,
    tail: &'a Arc<Mutex<String>>,
    started: &'a mut JoinSet<()>,
}

impl Talk<'_> {
    async fn run(mut self, start: String) -> ToolResult {
        let _ = send(&mut self.stdin, &start).await;
        let (reply_tx, mut replies) = mpsc::unbounded_channel::<String>();
        // 8 hexadecimal characters, fresh for each script.
        let script_id = flatbed::ids::new_entry_id();
        let options = &self.run_script.options;
        let mut calls = 0;
        loop {
            let line = tokio::select! {
                line = self.lines.recv() => line,
                Some(reply) = replies.recv() => {
                    // When the worker has gone, the next read says so.
                    let _ = send(&mut self.stdin, &reply).await;
                    continue;
                }
            };
            let line = match line {
                Some(Line::Text(line)) => line,
                Some(Line::TooLong) => {
                    return ToolResult::error(format!(
                        "The codemode worker sent a line longer than {MAX_MESSAGE_BYTES} bytes."
                    ))
                }
                None => return self.ended().await,
            };
            let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                return ToolResult::error(format!(
                    "The codemode worker sent a line that is not JSON: {}",
                    quote(&line)
                ));
            };
            let field = |name: &str| message.get(name).and_then(Value::as_str);
            match field("type") {
                Some("done") => {
                    let text = joined(field("output").unwrap_or(""), field("value"));
                    return text_result(if text.is_empty() {
                        "The script returned nothing.".into()
                    } else {
                        text
                    });
                }
                Some("error") => {
                    return ToolResult::error(joined(field("output").unwrap_or(""), field("error")))
                }
                Some("call") => {}
                _ => continue,
            }
            let (Some(id), Some(name), Some(input)) = (
                field("id"),
                field("name"),
                message.get("input").filter(|i| i.is_object()),
            ) else {
                return ToolResult::error(format!(
                    "The codemode worker sent a call it cannot make: {}",
                    quote(&line)
                ));
            };
            calls += 1;
            if calls > options.max_calls {
                return ToolResult::error(format!(
                    "The script made more than {} tool calls, so it was stopped.",
                    options.max_calls
                ));
            }
            let id = id.to_string();
            let call = ToolCall {
                id: format!("{script_id}-{id}"),
                name: name.to_string(),
                input: input.clone(),
            };
            let allowed = self.run_script.allowed.contains(&call.name);
            let (ctx, replies) = (self.ctx.clone(), reply_tx.clone());
            self.started.spawn(async move {
                // The core runs the call as it runs the model's, under the turn's limit. A name
                // off the allow-list is as unknown as a name nobody has.
                let result = if allowed {
                    // In a task of its own, so that a tool that panics still gets an answer, and
                    // the script never waits for one that will not come.
                    let (ctx, nested) = (ctx.clone(), call.clone());
                    tokio::spawn(async move { ctx.run_tool(nested).await })
                        .await
                        .unwrap_or_else(|_| {
                            ToolResult::error(format!("The {} tool panicked.", call.name))
                        })
                } else {
                    ToolResult::error(format!("No tool named {}.", call.name))
                };
                let data = json!({
                    "call": {"type": "toolCall", "id": call.id, "name": call.name, "input": call.input},
                    "result": {"content": result.content, "isError": result.is_error},
                });
                let _ = ctx.append("codemode", data).await;
                let _ = replies.send(reply(&id, &call, &result));
            });
        }
    }

    /// stdout closed before `done` or `error`. Killed first, so that a stray process holding
    /// stderr open cannot delay the end.
    async fn ended(self) -> ToolResult {
        kill_group(self.pid);
        let _ = tokio::time::timeout(Duration::from_secs(1), self.stderr).await;
        let tail = self.tail.lock().expect("codemode lock").trim().to_string();
        let mut message = "The codemode worker ended without finishing the script.".to_string();
        if !tail.is_empty() {
            message = format!("{message}\n{tail}");
        }
        ToolResult::error(message)
    }
}

async fn send(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(format!("{line}\n").as_bytes()).await?;
    stdin.flush().await
}
