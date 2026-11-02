//! One short real conversation through the Anthropic provider, with one tool call. It is ignored
//! by default and skips unless FLATBED_LIVE=1, so run it with:
//!
//!   FLATBED_LIVE=1 cargo test --test live -- --ignored
//!
//! It reads ANTHROPIC_API_KEY from .env at the repo root, and never prints it.

use async_trait::async_trait;
use flatbed::providers::anthropic::Anthropic;
use flatbed::{
    Agent, AgentConfig, Block, Contribution, Ctx, EntryBody, Event, FnTool, MemoryStore, Message,
    Outcome, Plugin, Provider, ProviderOptions, Section, Store, ToolDefinition, ToolResult,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

struct Adder;

#[async_trait]
impl Plugin for Adder {
    fn name(&self) -> &str {
        "live"
    }

    async fn context(&self, _ctx: &Ctx) -> flatbed::Result<Contribution> {
        let add = FnTool {
            definition: ToolDefinition {
                name: "add".into(),
                description: "Add two numbers. Use it for any sum you are asked to work out."
                    .into(),
                input_schema: json!({"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]}),
            },
            run: |input: Map<String, Value>, _: Ctx| async move {
                let number = |key: &str| input[key].as_f64().unwrap_or(0.0);
                Ok(ToolResult::text((number("a") + number("b")).to_string()))
            },
        };
        Ok(Contribution {
            sections: vec![Section {
                name: "soul".into(),
                text:
                    "You are a test agent. Use your tools when asked. Answer in one short sentence."
                        .into(),
                cache: Some(true),
            }],
            tools: vec![Box::new(add)],
            ..Contribution::default()
        })
    }
}

#[tokio::test]
#[ignore = "calls the Anthropic API; run with FLATBED_LIVE=1 and --ignored"]
async fn live_a_short_conversation_with_one_tool_call() {
    if std::env::var("FLATBED_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set FLATBED_LIVE=1 to call the Anthropic API");
        return;
    }
    let api_key =
        flatbed::env::read_env("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY is not set in .env");
    let store = Arc::new(MemoryStore::new());
    let mut config = AgentConfig::new("live", "anthropic/claude-sonnet-5-5");
    config.max_tokens = 1024;
    config.plugins.push(Box::new(Adder));
    let providers = HashMap::from([(
        "anthropic".to_string(),
        Arc::new(Anthropic::new(ProviderOptions::new(api_key))) as Arc<dyn Provider>,
    )]);
    let agent = Agent::new(config, store.clone(), providers).unwrap();
    agent.deliver(
        Event {
            kind: "message".into(),
            attrs: Some([("from".to_string(), "Tester".to_string())].into()),
            text: "Use the add tool to work out 1234 + 4321, then tell me the answer.".into(),
        },
        None,
    );
    let outcome = agent.run(None).await.unwrap();

    let ids = store.list("live").await.unwrap();
    let entries = store.read("live", &ids[0]).await.unwrap().entries;
    let failure = entries.iter().find_map(|e| match &e.body {
        EntryBody::Event(event) if event.text.starts_with("The model call failed") => {
            Some(event.text.clone())
        }
        _ => None,
    });
    assert_eq!(outcome, Outcome::Idle, "{}", failure.unwrap_or_default());
    let messages: Vec<&Message> = entries
        .iter()
        .filter_map(|e| match &e.body {
            EntryBody::Message { message } => Some(message),
            _ => None,
        })
        .collect();
    assert_eq!(
        messages
            .iter()
            .filter(|m| matches!(m, Message::Tool(_)))
            .count(),
        1
    );
    let Some(Message::Assistant(last)) = messages.last() else {
        panic!("the session should end with the model's answer");
    };
    let text: String = last
        .content
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.replace(',', "")),
            _ => None,
        })
        .collect();
    assert!(text.contains("5555"), "the answer should include 5555");
}
