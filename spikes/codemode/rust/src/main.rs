// ROUGH SPIKE PROBE. Not production code, not tested, not reviewed.
// Probes the in-process `monty` crate (Rust binding) for the codemode spike:
// the bridge, what a script can see, limits and cost. Run with:
// cargo run --release
// It makes no model calls and reads nothing from .env.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use monty::{MontyRun, RunProgress};
use monty_types::{
    CompileOptions, ExcType, ExtFunctionResult, MontyException, MontyObject, NameLookupResult, PrintWriter,
    ResourceLimits, ResourceTracker,
};
use tokio::task::JoinHandle;

const TOOLS: &[&str] = &["read_doc", "broken_tool", "slow_tool"];

/// The host side of each tool. `slow_tool` is async and runs as a tokio task.
fn sync_tool(name: &str, arg: String) -> Result<MontyObject, MontyException> {
    match name {
        "read_doc" => Ok(MontyObject::string(format!("contents of {arg}"))),
        "broken_tool" => Err(MontyException::new(
            ExcType::ValueError,
            Some(format!("tool failed inside host file {}", file!())),
        )),
        _ => Err(MontyException::new(ExcType::RuntimeError, Some(format!("no tool {name}")))),
    }
}

async fn slow_tool(arg: String) -> MontyObject {
    tokio::time::sleep(Duration::from_millis(300)).await;
    MontyObject::string(format!("done {arg}"))
}

/// Drives one script to completion, answering every suspension. Returns the
/// final value, the OS calls the script asked for, and the printed output.
async fn drive(code: &str, limits: ResourceLimits, out_cap: Option<usize>) -> (Result<MontyObject, String>, Vec<String>, String) {
    let mut printed = String::new();
    let mut os_calls = Vec::new();
    let runner = match MontyRun::new(code.to_owned(), "script.py", vec![], CompileOptions::default()) {
        Ok(r) => r,
        Err(e) => return (Err(e.to_string()), os_calls, printed),
    };
    let mut pending: HashMap<u32, JoinHandle<MontyObject>> = HashMap::new();
    let mut progress = runner.start(vec![], ResourceTracker::new(limits), PrintWriter::CollectString(&mut printed, out_cap));
    let result = loop {
        let p = match progress {
            Ok(p) => p,
            Err(e) => break Err(e.to_string()),
        };
        let print = PrintWriter::CollectString(&mut printed, out_cap);
        progress = match p {
            RunProgress::Complete(v) => break Ok(v),
            RunProgress::NameLookup(lookup) => {
                let r = if TOOLS.contains(&lookup.name.as_str()) {
                    NameLookupResult::Value(MontyObject::function(lookup.name.clone(), None))
                } else {
                    NameLookupResult::Undefined
                };
                lookup.resume(r, print)
            }
            RunProgress::FunctionCall(call) => {
                let arg = call.args.arg(0).map(|a| a.as_str().map(str::to_owned).unwrap_or_else(|| a.to_string())).unwrap_or_default();
                if call.function_name == "slow_tool" {
                    pending.insert(call.call_id, tokio::spawn(slow_tool(arg)));
                    call.resume_pending(print)
                } else {
                    match sync_tool(&call.function_name, arg) {
                        Ok(v) => call.resume(ExtFunctionResult::Return(v), print),
                        Err(e) => call.resume(ExtFunctionResult::Error(e), print),
                    }
                }
            }
            RunProgress::ResolveFutures(futs) => {
                let ids: Vec<u32> = futs.pending_call_ids().to_vec();
                let mut results = Vec::new();
                for id in ids {
                    if let Some(h) = pending.remove(&id) {
                        results.push((id, ExtFunctionResult::Return(h.await.unwrap())));
                    }
                }
                futs.resume(results, print)
            }
            RunProgress::OsCall(os) => {
                // The interpreter never touches the OS: it asks the host. This
                // host refuses everything except the sleeps asyncio needs.
                os_calls.push(format!("{:?}", os.function_call).chars().take(80).collect());
                os.resume(
                    ExtFunctionResult::Error(MontyException::new(ExcType::PermissionError, Some("refused by host".into()))),
                    print,
                )
            }
        };
    };
    (result, os_calls, printed)
}

fn line(title: &str, r: &(Result<MontyObject, String>, Vec<String>, String)) {
    let body = match &r.0 {
        Ok(v) => format!("OK -> {v}"),
        Err(e) => format!("ERR -> {e:?}"),
    };
    let os = if r.1.is_empty() { String::new() } else { format!("   [host saw OS calls: {:?}]", r.1) };
    let s: String = format!("  {title}: {body}{os}").chars().take(600).collect();
    println!("{s}");
}

#[tokio::main]
async fn main() {
    let d = ResourceLimits::default;
    println!("== bridge");
    line("tool call", &drive("read_doc('a')", d(), None).await);
    let t = Instant::now();
    let r = drive("import asyncio\nawait asyncio.gather(slow_tool('a'), slow_tool('b'), slow_tool('c'))", d(), None).await;
    line(&format!("3 x 0.3s async tools via gather in {:.2}s", t.elapsed().as_secs_f64()), &r);

    println!("== what a script can see");
    let escapes: &[(&str, &str)] = &[
        ("import os", "import os\nos.listdir('/')"),
        ("os.environ", "import os\ndict(os.environ)"),
        ("os.getenv HOME", "import os\nos.getenv('HOME')"),
        ("open", "open('/etc/passwd').read()"),
        ("__import__", "__import__('os')"),
        ("import subprocess", "import subprocess"),
        ("subclasses", "().__class__.__base__.__subclasses__()"),
        ("globals()", "globals()"),
        ("eval/exec", "exec('x = 1')\neval('1+1')"),
        ("inspect.getsource", "import inspect\ninspect.getsource(read_doc)"),
        ("tool repr", "repr(read_doc)"),
        ("tool __code__", "read_doc.__code__"),
        ("tool __globals__", "read_doc.__globals__"),
        ("guess other name", "TOOLS"),
        ("host raises (uncaught)", "broken_tool(1)"),
        ("host raises (caught)", "try:\n    broken_tool(1)\nexcept Exception as e:\n    out = (type(e).__name__, str(e))\nout"),
        ("time.time", "import time\ntime.time()"),
    ];
    for (title, code) in escapes {
        line(title, &drive(code, d(), None).await);
    }

    println!("== limits");
    let cases: &[(&str, &str, ResourceLimits)] = &[
        ("time: while True", "while True:\n    pass", ResourceLimits { max_feed_duration: Some(Duration::from_millis(500)), ..d() }),
        ("memory: big list", "x = [0] * 100_000_000", ResourceLimits { max_memory: Some(10_000_000), ..d() }),
        ("memory: grow loop", "x = []\nwhile True:\n    x.append('a' * 1000)", ResourceLimits { max_memory: Some(10_000_000), ..d() }),
        ("recursion", "def f(n):\n    return f(n + 1)\nf(0)", ResourceLimits { max_recursion_depth: 100, ..d() }),
        ("suspensions (host must enforce)", "for i in range(50):\n    read_doc('x')\n'all 50 ran'", ResourceLimits { max_suspensions: 10, ..d() }),
    ];
    for (title, code, lim) in cases {
        let t = Instant::now();
        line(title, &drive(code, lim.clone(), None).await);
        println!("    took {:.2}s", t.elapsed().as_secs_f64());
    }
    let r = drive("for i in range(100000):\n    print('spam')", d(), Some(10_000)).await;
    line("output cap 10kB", &r);
    println!("    collected {} bytes before the cap", r.2.len());

    println!("== cost");
    let n = 1000;
    let t = Instant::now();
    for _ in 0..n {
        let _ = drive("read_doc('a') + 'x'", d(), None).await;
    }
    println!("  in-process parse + run with one tool call: {:.3} ms each over {n}", t.elapsed().as_secs_f64() * 1000.0 / n as f64);
}
