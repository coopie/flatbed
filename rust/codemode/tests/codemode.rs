//! The codemode plugin, with the fake provider and the real worker process. Each test passes
//! without running when `uv` is missing, and says so.

use async_trait::async_trait;
use flatbed::providers::faux::{Faux, Script, Scripted};
use flatbed::{
    Agent, AgentConfig, Block, Contribution, Ctx, Entry, EntryBody, Event, FnTool, MemoryStore,
    Message, Outcome, Plugin, Provider, StopSignal, Store, ToolCall, ToolDefinition, ToolResult,
};
use flatbed_codemode::{with_codemode, CodemodeOptions};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn has_uv() -> bool {
    let found = std::process::Command::new("uv")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !found {
        eprintln!("Skipped: uv is not installed, so the codemode worker cannot run.");
    }
    found
}

#[derive(Default, Clone)]
struct Seen {
    spans: Arc<Mutex<Vec<(Instant, Instant)>>>,
    sent: Arc<Mutex<Vec<String>>>,
}

fn tool<F, Fut>(name: &str, description: &str, param: &str, run: F) -> Box<dyn flatbed::Tool>
where
    F: Fn(Map<String, Value>, Ctx) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = flatbed::Result<ToolResult>> + Send + 'static,
{
    Box::new(FnTool {
        definition: ToolDefinition {
            name: name.into(),
            description: description.into(),
            input_schema: json!({"type": "object", "properties": {param: {"type": "string"}}, "required": [param]}),
        },
        run,
    })
}

/// Adds `slow`, `read_doc` and `send_email`.
struct Tools {
    seen: Seen,
    stop_after_slow: Option<StopSignal>,
}

#[async_trait]
impl Plugin for Tools {
    fn name(&self) -> &str {
        "tools"
    }
    async fn context(&self, _ctx: &Ctx) -> flatbed::Result<Contribution> {
        let spans = self.seen.spans.clone();
        let stop = self.stop_after_slow.clone();
        let slow = tool(
            "slow",
            "Wait a moment, then say done.",
            "label",
            move |input, _| {
                let spans = spans.clone();
                let stop = stop.clone();
                async move {
                    let start = Instant::now();
                    if let Some(stop) = stop {
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            stop.set("Sam");
                        });
                    }
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    spans.lock().unwrap().push((start, Instant::now()));
                    Ok(ToolResult::text(format!(
                        "done {}",
                        input["label"].as_str().unwrap_or("")
                    )))
                }
            },
        );
        let read_doc = tool(
            "read_doc",
            "Read one of your documents by name.",
            "name",
            |input, _| async move {
                Ok(ToolResult::text(format!(
                    "contents of {}",
                    input["name"].as_str().unwrap_or("")
                )))
            },
        );
        let sent = self.seen.sent.clone();
        let send_email = tool("send_email", "Send an email.", "to", move |input, _| {
            let sent = sent.clone();
            async move {
                sent.lock()
                    .unwrap()
                    .push(input["to"].as_str().unwrap_or("").into());
                Ok(ToolResult::text("sent"))
            }
        });
        Ok(Contribution {
            tools: vec![slow, read_doc, send_email],
            ..Contribution::default()
        })
    }
}

/// A guard, to show that nested calls pass through the agent's own hooks.
struct Guard;

#[async_trait]
impl Plugin for Guard {
    fn name(&self) -> &str {
        "guard"
    }
    async fn before_tool(
        &self,
        call: &ToolCall,
        _ctx: &Ctx,
    ) -> flatbed::Result<Option<ToolResult>> {
        let secret = call.name == "read_doc" && call.input["name"] == "secret";
        Ok(secret.then(|| ToolResult::error("Refused.")))
    }
}

struct Setup {
    agent: Agent,
    store: Arc<dyn Store>,
    faux: Arc<Faux>,
    seen: Seen,
}

fn setup(
    script: &str,
    change: impl FnOnce(&mut CodemodeOptions),
    stop: Option<StopSignal>,
) -> Setup {
    setup_with_places(script, change, stop, 4)
}

fn setup_with_places(
    script: &str,
    change: impl FnOnce(&mut CodemodeOptions),
    stop: Option<StopSignal>,
    max_concurrent_tools: usize,
) -> Setup {
    let seen = Seen::default();
    let mut options = CodemodeOptions::new(["slow", "read_doc"]);
    change(&mut options);
    let tools = Tools {
        seen: seen.clone(),
        stop_after_slow: stop,
    };
    let mut config = AgentConfig::new("coder", "faux/test");
    config.max_concurrent_tools = max_concurrent_tools;
    config.plugins = with_codemode(vec![Box::new(tools), Box::new(Guard)], options);
    let call = json!({"type": "toolCall", "id": "call_1", "name": "run_script", "input": {"script": script}});
    let faux = Arc::new(Faux::new(vec![
        Script::Response(Scripted {
            content: vec![serde_json::from_value(call).unwrap()],
            ..Default::default()
        }),
        Script::Response(Scripted {
            content: vec![Block::text("Done.")],
            ..Default::default()
        }),
    ]));
    let store: Arc<dyn Store> = Arc::new(MemoryStore::new());
    let providers = HashMap::from([("faux".to_string(), faux.clone() as Arc<dyn Provider>)]);
    let agent = Agent::new(config, store.clone(), providers).unwrap();
    agent.deliver(
        Event {
            kind: "message".into(),
            attrs: None,
            text: "Go.".into(),
        },
        None,
    );
    Setup {
        agent,
        store,
        faux,
        seen,
    }
}

async fn entries(store: &Arc<dyn Store>) -> Vec<Entry> {
    let ids = store.list("coder").await.unwrap();
    store.read("coder", &ids[0]).await.unwrap().entries
}

fn script_result(entries: &[Entry]) -> (String, bool) {
    entries
        .iter()
        .find_map(|e| match &e.body {
            EntryBody::Message {
                message: Message::Tool(m),
            } => Some((
                m.content
                    .iter()
                    .map(|b| match b {
                        Block::Text { text } => text.as_str(),
                        _ => "",
                    })
                    .collect(),
                m.is_error,
            )),
            _ => None,
        })
        .unwrap()
}

fn nested(entries: &[Entry]) -> Vec<(String, bool)> {
    entries
        .iter()
        .filter_map(|e| match &e.body {
            EntryBody::Custom { plugin, data } if plugin == "codemode" => Some((
                data["call"]["name"].as_str().unwrap().to_string(),
                data["result"]["isError"].as_bool().unwrap(),
            )),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn two_gathered_calls_run_at_once_through_the_hooks_and_are_recorded() {
    if !has_uv() {
        return;
    }
    let s = setup(
        "import asyncio\na, b = await asyncio.gather(slow('a'), slow(label='b'))\ntry:\n    await read_doc('secret')\nexcept RuntimeError as e:\n    print('guard said', e)\n[a, b]",
        |_| {},
        None,
    );
    assert_eq!(s.agent.run(None).await.unwrap(), Outcome::Idle);
    let found = entries(&s.store).await;
    assert_eq!(
        script_result(&found),
        (
            "guard said Refused.\n[\"done a\", \"done b\"]".to_string(),
            false
        )
    );
    let spans = s.seen.spans.lock().unwrap().clone();
    assert_eq!(spans.len(), 2);
    // Each started before the other ended.
    assert!(spans[0].0 < spans[1].1 && spans[1].0 < spans[0].1);
    assert_eq!(
        nested(&found),
        [
            ("slow".into(), false),
            ("slow".into(), false),
            ("read_doc".into(), true)
        ]
    );
    let requests = s.faux.requests();
    let description = &requests[0]
        .tools
        .iter()
        .find(|t| t.name == "run_script")
        .unwrap()
        .description;
    assert!(description.contains("async def slow(label: str) -> str:"));
    assert!(!description.contains("send_email"));
}

#[tokio::test]
async fn a_tool_off_the_allow_list_does_not_exist_inside_the_script() {
    if !has_uv() {
        return;
    }
    let s = setup("await send_email('someone@example.com')", |_| {}, None);
    s.agent.run(None).await.unwrap();
    let (text, is_error) = script_result(&entries(&s.store).await);
    assert!(is_error);
    assert!(
        text.contains("NameError: name 'send_email' is not defined"),
        "{text}"
    );
    assert!(s.seen.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_script_that_makes_more_calls_than_the_limit_is_stopped() {
    if !has_uv() {
        return;
    }
    let s = setup(
        "for i in range(10):\n    await read_doc(str(i))",
        |o| o.max_calls = 3,
        None,
    );
    s.agent.run(None).await.unwrap();
    let found = entries(&s.store).await;
    assert_eq!(
        script_result(&found),
        (
            "The script made more than 3 tool calls, so it was stopped.".to_string(),
            true
        )
    );
    assert_eq!(nested(&found).len(), 3);
}

#[tokio::test]
async fn a_script_that_runs_past_its_deadline_is_stopped() {
    if !has_uv() {
        return;
    }
    let s = setup(
        "while True:\n    pass",
        |o| o.timeout = Duration::from_secs(1),
        None,
    );
    let started = Instant::now();
    s.agent.run(None).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(
        script_result(&entries(&s.store).await),
        (
            "The script ran for more than 1 seconds, so it was stopped.".to_string(),
            true
        )
    );
}

#[tokio::test]
async fn a_stop_during_a_script_ends_the_script_and_the_run() {
    if !has_uv() {
        return;
    }
    let stop = StopSignal::new();
    let s = setup(
        "await slow('a')\nwhile True:\n    pass",
        |_| {},
        Some(stop.clone()),
    );
    assert_eq!(s.agent.run(Some(&stop)).await.unwrap(), Outcome::Stopped);
    let found = entries(&s.store).await;
    assert_eq!(
        script_result(&found),
        ("The harness stopped this script.".to_string(), true)
    );
    let EntryBody::Event(last) = &found.last().unwrap().body else {
        panic!("the last entry should be the stop notice");
    };
    assert_eq!(last.text, "Stopped by Sam.");
}

#[tokio::test]
async fn an_error_in_a_script_comes_back_with_what_it_printed_first() {
    if !has_uv() {
        return;
    }
    let s = setup("print('before')\n1 / 0", |_| {}, None);
    s.agent.run(None).await.unwrap();
    let (text, is_error) = script_result(&entries(&s.store).await);
    assert!(is_error);
    assert!(text.starts_with("before\n"), "{text}");
    assert!(
        text.contains("ZeroDivisionError: division by zero"),
        "{text}"
    );
}

#[tokio::test]
async fn gathered_calls_take_turns_when_the_agent_allows_one_call_at_a_time() {
    if !has_uv() {
        return;
    }
    let s = setup_with_places(
        "import asyncio\nawait asyncio.gather(slow('a'), slow('b'))",
        |_| {},
        None,
        1,
    );
    assert_eq!(s.agent.run(None).await.unwrap(), Outcome::Idle);
    assert_eq!(
        script_result(&entries(&s.store).await),
        ("[\"done a\", \"done b\"]".to_string(), false)
    );
    // run_script gave up its place, so its calls could run, one after the other.
    let mut spans = s.seen.spans.lock().unwrap().clone();
    spans.sort();
    assert_eq!(spans.len(), 2);
    assert!(spans[0].1 <= spans[1].0);
}

#[tokio::test]
async fn a_script_cannot_pass_the_message_cap_with_a_call_or_its_value() {
    if !has_uv() {
        return;
    }
    let big = "s = 'x' * 1000000\n";
    let s = setup(
        &format!("{big}try:\n    await read_doc(s + s)\nexcept ValueError as e:\n    print(e)\nlen([s] * 200)"),
        |_| {},
        None,
    );
    s.agent.run(None).await.unwrap();
    let found = entries(&s.store).await;
    assert_eq!(
        script_result(&found),
        (
            "read_doc() was given more than the 1048576-byte limit for a message.\n200".to_string(),
            false
        )
    );
    assert!(nested(&found).is_empty());

    let s = setup(&format!("{big}[s] * 200"), |_| {}, None);
    s.agent.run(None).await.unwrap();
    assert_eq!(
        script_result(&entries(&s.store).await),
        (
            "The script's result is larger than the 1048576-byte limit for a message.".to_string(),
            true
        )
    );
}

#[tokio::test]
async fn the_host_stops_at_a_line_longer_than_the_cap_and_quotes_little_of_a_bad_line() {
    let worker = |code: &str| Some(["python3", "-c", code].map(String::from).to_vec());
    let s = setup(
        "1",
        |o| {
            o.worker =
                worker("import time; print('x' * 2 * 1024 * 1024, flush=True); time.sleep(5)")
        },
        None,
    );
    let started = Instant::now();
    s.agent.run(None).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(
        script_result(&entries(&s.store).await).0,
        "The codemode worker sent a line longer than 1048576 bytes."
    );

    let s = setup(
        "1",
        |o| o.worker = worker("print('x' * 100000, flush=True)"),
        None,
    );
    s.agent.run(None).await.unwrap();
    assert_eq!(
        script_result(&entries(&s.store).await).0,
        format!(
            "The codemode worker sent a line that is not JSON: {}",
            "x".repeat(200)
        )
    );
}

#[tokio::test]
async fn calls_a_script_started_finish_and_are_recorded_before_run_script_returns() {
    if !has_uv() {
        return;
    }
    // The limit is 1, so the second call ends the script while the first is still running.
    let s = setup(
        "import asyncio\nawait asyncio.gather(slow('a'), slow('b'))",
        |o| o.max_calls = 1,
        None,
    );
    s.agent.run(None).await.unwrap();
    let found = entries(&s.store).await;
    assert_eq!(
        script_result(&found),
        (
            "The script made more than 1 tool calls, so it was stopped.".to_string(),
            true
        )
    );
    assert_eq!(s.seen.spans.lock().unwrap().len(), 1);
    let records: Vec<&Value> = found
        .iter()
        .filter_map(|e| match &e.body {
            EntryBody::Custom { plugin, data } if plugin == "codemode" => Some(data),
            _ => None,
        })
        .collect();
    assert_eq!(records.len(), 1);
    let call = &records[0]["call"];
    assert_eq!(call["type"], "toolCall");
    let id = call["id"].as_str().unwrap();
    assert!(id.len() == 10 && id.ends_with("-1"), "{id}");
    assert_eq!(
        records[0]["result"],
        json!({"content": [{"type": "text", "text": "done a"}], "isError": false})
    );
}

#[tokio::test]
async fn nan_and_infinity_never_reach_the_host_as_invalid_json() {
    if !has_uv() {
        return;
    }
    let s = setup(
        "try:\n    await read_doc(float('nan'))\nexcept ValueError as e:\n    print('refused')\n[float('inf'), 1]",
        |_| {},
        None,
    );
    s.agent.run(None).await.unwrap();
    let found = entries(&s.store).await;
    assert_eq!(
        script_result(&found),
        ("refused\n[inf, 1]".to_string(), false)
    );
    assert!(nested(&found).is_empty());
}
