//! Sessions on disk: the Rust core reads what the TypeScript core wrote, writes the same objects
//! back, and resumes a session another process opened. The conformance suite covers the loop.

use async_trait::async_trait;
use flatbed::providers::faux::{Faux, Script, Scripted};
use flatbed::render::{path_of, render};
use flatbed::{
    Agent, AgentConfig, Block, Contribution, Ctx, Event, FileStore, FnTool, Message, Outcome,
    Plugin, Provider, Store, ToolDefinition, ToolResult,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts-store")
}

#[tokio::test]
async fn reads_a_session_the_typescript_core_wrote() {
    let store = FileStore::new(fixture_root());
    let ids = store.list("fixture").await.unwrap();
    assert_eq!(ids, ["2026-10-06T22-51-41Z-1e57"]);
    let session = store.read("fixture", &ids[0]).await.unwrap();
    assert_eq!(session.entries.len(), 12);

    // Every line comes back out as the same JSON object, so TypeScript can read what Rust writes.
    let path = fixture_root()
        .join("fixture")
        .join(format!("{}.jsonl", ids[0]));
    let text = std::fs::read_to_string(path).unwrap();
    let mut lines = text
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap());
    assert_eq!(
        serde_json::to_value(&session.header).unwrap(),
        lines.next().unwrap()
    );
    for (entry, line) in session.entries.iter().zip(lines) {
        assert_eq!(serde_json::to_value(entry).unwrap(), line);
    }

    let (context, messages) = render(&path_of(&session.entries));
    assert_eq!(context.tools.len(), 2);
    let Message::User(first) = &messages[0] else {
        panic!("the first message should be from the user");
    };
    assert_eq!(
        first.content[1],
        Block::text("<message from=\"Ada\" via=\"cli\">Echo &lt;a &amp; b&gt;</message>")
    );
}

/// A plugin with one `echo` tool, as a host would write one.
struct Echo;

#[async_trait]
impl Plugin for Echo {
    fn name(&self) -> &str {
        "echo"
    }

    async fn context(&self, _ctx: &Ctx) -> flatbed::Result<Contribution> {
        let echo = FnTool {
            definition: ToolDefinition {
                name: "echo".into(),
                description: "Echo the text.".into(),
                input_schema: json!({"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}),
            },
            run: |input: serde_json::Map<String, Value>, _: Ctx| async move {
                Ok(ToolResult::text(input["text"].as_str().unwrap_or("")))
            },
        };
        Ok(Contribution {
            tools: vec![Box::new(echo)],
            ..Contribution::default()
        })
    }
}

fn agent(store: Arc<dyn Store>, script: Vec<Scripted>) -> Agent {
    let mut config = AgentConfig::new("tester", "faux/test");
    config.plugins.push(Box::new(Echo));
    let faux = Faux::new(script.into_iter().map(Script::Response).collect());
    let providers = HashMap::from([("faux".to_string(), Arc::new(faux) as Arc<dyn Provider>)]);
    Agent::new(config, store, providers).unwrap()
}

#[tokio::test]
async fn resumes_a_session_another_process_opened() {
    let root = std::env::temp_dir().join(format!("flatbed-test-{}", flatbed::ids::new_entry_id()));
    let store: Arc<dyn Store> = Arc::new(FileStore::new(&root));
    let say = |text: &str| Event {
        kind: "message".into(),
        attrs: None,
        text: text.into(),
    };

    let first = agent(
        store.clone(),
        vec![Scripted {
            content: vec![Block::text("Hi.")],
            ..Default::default()
        }],
    );
    first.deliver(say("Hello"), None);
    assert_eq!(first.run(None).await.unwrap(), Outcome::Idle);

    // A second agent, as in a new process, finds the open session and loads the tools' code again.
    let call = json!({"type": "toolCall", "id": "c1", "name": "echo", "input": {"text": "again"}});
    let script = vec![
        Scripted {
            content: vec![serde_json::from_value(call).unwrap()],
            ..Default::default()
        },
        Scripted {
            content: vec![Block::text("Done.")],
            ..Default::default()
        },
    ];
    let second = agent(store.clone(), script);
    second.deliver(say("Echo again"), None);
    assert_eq!(second.run(None).await.unwrap(), Outcome::Idle);

    let ids = store.list("tester").await.unwrap();
    assert_eq!(ids.len(), 1);
    let session = store.read("tester", &ids[0]).await.unwrap();
    let results: Vec<_> = session
        .entries
        .iter()
        .filter_map(|e| match &e.body {
            flatbed::EntryBody::Message {
                message: Message::Tool(result),
            } => Some(result),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].content, [Block::text("again")]);
    assert!(!results[0].is_error);
    std::fs::remove_dir_all(root).unwrap();
}
