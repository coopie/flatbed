// ROUGH SPIKE PROBE. Not production code, not tested, not reviewed.
// Probes `monty-pool` (Rust, subprocess workers) for the codemode spike. The
// worker binary is the `monty` 1.2.0 CLI from the Python venv, passed as the
// first argument. Run with:
// cargo run --release --bin pool -- ../python/.venv/bin/monty

use std::collections::HashMap;
use std::time::{Duration, Instant};

use monty_pool::{Pool, PoolConfig, ReplConfig, ResumeValue, TurnEvent, on_print_sync};
use monty_types::{MontyObject, NameLookupResult, ResourceLimits};
use tokio::task::JoinHandle;

async fn run(pool: &Pool, code: &str, limits: Option<ResourceLimits>) -> String {
    let repl = ReplConfig { limits, ..ReplConfig::default() };
    let mut s = match pool.checkout(&repl).await {
        Ok(s) => s,
        Err(e) => return format!("CHECKOUT ERR {e}"),
    };
    let mut printed = String::new();
    let mut on_print = on_print_sync(|_, t| printed.push_str(t));
    let mut pending: HashMap<u32, JoinHandle<MontyObject>> = HashMap::new();
    let mut os_calls = Vec::new();
    let mut ev = s.feed(code, vec![], vec![], true, &mut on_print).await;
    let out = loop {
        let e = match ev {
            Ok(e) => e,
            Err(err) => break format!("ERR {err}"),
        };
        ev = match e {
            TurnEvent::Complete(v) => break format!("OK {v}"),
            TurnEvent::NameLookup { name, .. } => {
                let r = if name == "read_doc" || name == "slow_tool" {
                    NameLookupResult::Value(MontyObject::function(name, None))
                } else {
                    NameLookupResult::Undefined
                };
                s.resume_name_lookup(r, &mut on_print).await
            }
            TurnEvent::FunctionCall { function_name, call_id, args, .. } => {
                let arg = args.arg(0).map(|a| a.to_string()).unwrap_or_default();
                if function_name == "slow_tool" {
                    pending.insert(
                        call_id,
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            MontyObject::string(format!("done {arg}"))
                        }),
                    );
                    s.resume(ResumeValue::Future, &mut on_print).await
                } else {
                    s.resume(ResumeValue::Return(MontyObject::string(format!("contents of {arg}"))), &mut on_print).await
                }
            }
            TurnEvent::ResolveFutures { pending_call_ids, .. } => {
                let mut results = Vec::new();
                for id in pending_call_ids {
                    if let Some(h) = pending.remove(&id) {
                        results.push((id, ResumeValue::Return(h.await.unwrap())));
                    }
                }
                s.resume_futures(results, &mut on_print).await
            }
            TurnEvent::OsCall { function_name, .. } => {
                os_calls.push(function_name);
                s.resume(ResumeValue::NotHandled, &mut on_print).await
            }
        };
    };
    drop(on_print);
    let _ = s.finish().await;
    let os = if os_calls.is_empty() { String::new() } else { format!("   [host saw OS calls {os_calls:?}]") };
    format!("{out}{os}").chars().take(400).collect()
}

#[tokio::main]
async fn main() {
    let bin = std::env::args().nth(1).expect("pass the monty worker binary path");
    let mut config = PoolConfig::subprocess(bin);
    config.request_timeout = Some(Duration::from_secs(5));
    let t = Instant::now();
    let pool = Pool::new(config).await.expect("pool");
    println!("pool start: {:.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    println!("tool call: {}", run(&pool, "read_doc('a')", None).await);
    let t = Instant::now();
    let r = run(&pool, "import asyncio\nawait asyncio.gather(slow_tool('a'), slow_tool('b'), slow_tool('c'))", None).await;
    println!("3 x 0.3s gather in {:.2}s: {r}", t.elapsed().as_secs_f64());
    println!("os.getenv: {}", run(&pool, "import os\nos.getenv('HOME')", None).await);
    println!("__import__: {}", run(&pool, "__import__('os')", None).await);
    let lim = ResourceLimits { max_suspensions: 10, ..ResourceLimits::default() };
    println!("suspensions: {}", run(&pool, "for i in range(50):\n    read_doc('x')", Some(lim)).await);
    let lim = ResourceLimits { max_feed_duration: Some(Duration::from_millis(500)), ..ResourceLimits::default() };
    println!("time limit: {}", run(&pool, "while True:\n    pass", Some(lim)).await);
    let n = 200;
    let t = Instant::now();
    for _ in 0..n {
        run(&pool, "read_doc('a') + 'x'", None).await;
    }
    println!("warm checkout + feed with one tool call: {:.2} ms each over {n}", t.elapsed().as_secs_f64() * 1000.0 / n as f64);
    pool.close().await;
}
