//! `Ctx::run_tool` in a case the conformance suite cannot express: a tool that ends while a call
//! it made is still running.

use async_trait::async_trait;
use flatbed::providers::faux::{Faux, Script, Scripted};
use flatbed::{
    Agent, AgentConfig, Block, Contribution, Ctx, Event, FnTool, MemoryStore, Outcome, Plugin,
    Provider, ToolCall, ToolDefinition, ToolResult,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;

#[derive(Default)]
struct Counts {
    now: AtomicUsize,
    most: AtomicUsize,
    left: Mutex<Vec<JoinHandle<ToolResult>>>,
}

/// `slow` waits a moment; `leave` starts a `slow` call and returns without waiting for it.
struct Tools(Arc<Counts>);

fn definition(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: format!("The {name} tool."),
        input_schema: json!({"type": "object"}),
    }
}

#[async_trait]
impl Plugin for Tools {
    fn name(&self) -> &str {
        "tools"
    }

    async fn context(&self, _ctx: &Ctx) -> flatbed::Result<Contribution> {
        let counts = self.0.clone();
        let slow = FnTool {
            definition: definition("slow"),
            run: move |_: Map<String, Value>, _: Ctx| {
                let counts = counts.clone();
                async move {
                    let now = counts.now.fetch_add(1, Ordering::SeqCst) + 1;
                    counts.most.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    counts.now.fetch_sub(1, Ordering::SeqCst);
                    Ok(ToolResult::text("Waited."))
                }
            },
        };
        let counts = self.0.clone();
        let leave = FnTool {
            definition: definition("leave"),
            run: move |_: Map<String, Value>, ctx: Ctx| {
                let counts = counts.clone();
                async move {
                    let call = ToolCall {
                        id: "n1".into(),
                        name: "slow".into(),
                        input: json!({}),
                    };
                    let left = tokio::spawn(async move { ctx.run_tool(call).await });
                    counts.left.lock().unwrap().push(left);
                    Ok(ToolResult::text("Left."))
                }
            },
        };
        Ok(Contribution {
            tools: vec![Box::new(slow), Box::new(leave)],
            ..Contribution::default()
        })
    }
}

#[tokio::test]
async fn a_tool_that_ends_while_a_call_it_made_still_runs_leaves_the_limit_as_it_found_it() {
    // With one place: `leave`, then two `slow` calls.
    let counts = Arc::new(Counts::default());
    let calls = ["leave", "slow", "slow"]
        .iter()
        .enumerate()
        .map(|(i, name)| {
            serde_json::from_value(
                json!({"type": "toolCall", "id": format!("c{i}"), "name": name, "input": {}}),
            )
            .unwrap()
        });
    let faux = Faux::new(vec![
        Script::Response(Scripted {
            content: calls.collect(),
            ..Default::default()
        }),
        Script::Response(Scripted {
            content: vec![Block::text("Done.")],
            ..Default::default()
        }),
    ]);
    let mut config = AgentConfig::new("a", "faux/test");
    config.plugins.push(Box::new(Tools(counts.clone())));
    config.max_concurrent_tools = 1;
    let providers = HashMap::from([("faux".to_string(), Arc::new(faux) as Arc<dyn Provider>)]);
    let agent = Agent::new(config, Arc::new(MemoryStore::default()), providers).unwrap();
    agent.deliver(
        Event {
            kind: "message".into(),
            attrs: None,
            text: "Go".into(),
        },
        None,
    );

    assert_eq!(agent.run(None).await.unwrap(), Outcome::Idle);
    let left: Vec<_> = counts.left.lock().unwrap().drain(..).collect();
    for handle in left {
        assert_eq!(handle.await.unwrap(), ToolResult::text("Waited."));
    }
    assert_eq!(counts.most.load(Ordering::SeqCst), 1);
}
