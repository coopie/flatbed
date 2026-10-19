//! A rough CLI for trying the core by hand. It is a one-off tool, not part of the core: no tests,
//! few checks, and output shaped for reading rather than parsing.
//!
//!   cargo run -- chat <agent>          talk to an agent in the terminal
//!   cargo run -- view <session-file>   print a session as the model sees it
//!
//! `chat` keeps sessions under `data/` at the repo root. It uses the model in FLATBED_MODEL, which
//! defaults to `anthropic/claude-sonnet-5-5`; `faux/echo` answers offline by echoing you. The key
//! comes from ANTHROPIC_API_KEY, or OPENAI_API_KEY for `openai/...`, in .env at the repo root.

use async_trait::async_trait;
use flatbed::providers::anthropic::Anthropic;
use flatbed::providers::openai::OpenAi;
use flatbed::render::{path_of, render};
use flatbed::store::parse_session;
use flatbed::{
    Agent, AgentConfig, AssistantMessage, Block, Contribution, Ctx, Entry, EntryBody, Event,
    FileStore, Message, Plugin, Provider, ProviderOptions, Request, Section, Stop, Usage,
};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, Write};
use std::sync::Arc;

/// An offline stand-in that echoes the last thing said, for as long as you like.
struct EchoProvider;

#[async_trait]
impl Provider for EchoProvider {
    async fn complete(&self, request: &Request) -> flatbed::Result<AssistantMessage> {
        let said = match request.messages.last() {
            Some(Message::User(user)) => user
                .content
                .iter()
                .map(block_text)
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        };
        Ok(AssistantMessage {
            content: vec![Block::text(format!("You said: {said}"))],
            model: format!("faux/{}", request.model),
            usage: Usage::default(),
            stop: Stop::End,
        })
    }
}

/// Prints what happens in the session as it happens.
struct Printer {
    agent: String,
}

#[async_trait]
impl Plugin for Printer {
    fn name(&self) -> &str {
        "printer"
    }

    async fn context(&self, _ctx: &Ctx) -> flatbed::Result<Contribution> {
        let text = format!(
            "You are {}, talking with a person in a terminal. Keep answers short.",
            self.agent
        );
        Ok(Contribution {
            sections: vec![Section {
                name: "soul".into(),
                text,
                cache: Some(true),
            }],
            tools: Vec::new(),
        })
    }

    async fn on_entry(&self, entry: &Entry, _ctx: &Ctx) {
        match &entry.body {
            EntryBody::Message {
                message: Message::Assistant(m),
            } if !m.content.is_empty() => {
                println!(
                    "{}",
                    m.content
                        .iter()
                        .map(block_text)
                        .collect::<Vec<_>>()
                        .join("\n")
                );
            }
            EntryBody::Message {
                message: Message::Tool(t),
            } => {
                println!(
                    "[{}: {}]",
                    t.name,
                    t.content
                        .iter()
                        .map(block_text)
                        .collect::<Vec<_>>()
                        .join(" ")
                );
            }
            EntryBody::Event(e) if e.kind == "notice" => println!("[notice] {}", e.text),
            EntryBody::Reset { by, reason } => {
                println!(
                    "[reset by {by}{}]",
                    reason
                        .as_ref()
                        .map(|r| format!(": {r}"))
                        .unwrap_or_default()
                );
            }
            _ => {}
        }
    }
}

fn block_text(block: &Block) -> String {
    match block {
        Block::Text { text } => text.clone(),
        Block::ToolCall(call) => format!("[call {} {}]", call.name, call.input),
        Block::Thinking { text, .. } => format!("[thinking] {text}"),
        Block::Image { mime_type, .. } => format!("[image {mime_type}]"),
    }
}

async fn chat(agent_id: &str) -> flatbed::Result<()> {
    let model =
        std::env::var("FLATBED_MODEL").unwrap_or_else(|_| "anthropic/claude-sonnet-5-5".into());
    let mut providers: HashMap<String, Arc<dyn Provider>> = HashMap::new();
    providers.insert("faux".into(), Arc::new(EchoProvider));
    if let Some(key) = flatbed::env::read_env("ANTHROPIC_API_KEY") {
        let anthropic = Anthropic::new(ProviderOptions::new(key));
        providers.insert("anthropic".into(), Arc::new(anthropic));
    }
    if let Some(key) = flatbed::env::read_env("OPENAI_API_KEY") {
        providers.insert(
            "openai".into(),
            Arc::new(OpenAi::new(ProviderOptions::new(key))),
        );
    }
    let data = flatbed::env::repo_root().join("data");
    let mut config = AgentConfig::new(agent_id, &model);
    config.plugins.push(Box::new(Printer {
        agent: agent_id.into(),
    }));
    let agent = Agent::new(config, Arc::new(FileStore::new(&data)), providers)?;
    println!(
        "Talking to {agent_id} on {model}. Sessions are in {}. Press Ctrl-D to leave.",
        data.join(agent_id).display()
    );
    let you = std::env::var("USER").unwrap_or_else(|_| "you".into());
    prompt();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        if !line.trim().is_empty() {
            let event = Event {
                kind: "message".into(),
                attrs: Some(BTreeMap::from([("from".to_string(), you.clone())])),
                text: line,
            };
            agent.deliver(event, None);
            agent.run(None).await?;
        }
        prompt();
    }
    Ok(())
}

fn prompt() {
    print!("> ");
    std::io::stdout().flush().ok();
}

fn view(file: &str) -> flatbed::Result<()> {
    let session = parse_session(&std::fs::read_to_string(file)?)?;
    let (context, messages) = render(&path_of(&session.entries));
    let header = &session.header;
    let parent = header
        .parent
        .as_ref()
        .map(|p| format!(", after {} ({})", p.session, p.reason));
    println!(
        "session {} of {}{}",
        header.id,
        header.agent,
        parent.unwrap_or_default()
    );
    for section in &context.sections {
        let cache = if section.cache == Some(true) {
            " (cache)"
        } else {
            ""
        };
        println!("--- section {}{cache}\n{}", section.name, section.text);
    }
    let tools: Vec<&str> = context.tools.iter().map(|t| t.name.as_str()).collect();
    println!("--- tools: {}", tools.join(", "));
    for message in &messages {
        let (head, content) = match message {
            Message::User(m) => ("--- user".to_string(), &m.content),
            Message::Assistant(m) => (
                format!(
                    "--- assistant ({}, stop {})",
                    m.model,
                    serde_json::json!(m.stop).as_str().unwrap_or("?")
                ),
                &m.content,
            ),
            Message::Tool(m) => (
                format!(
                    "--- tool {}{}",
                    m.name,
                    if m.is_error { " (error)" } else { "" }
                ),
                &m.content,
            ),
        };
        println!(
            "{head}\n{}",
            content
                .iter()
                .map(block_text)
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match (args.first().map(String::as_str), args.get(1)) {
        (Some("chat"), Some(agent)) => chat(agent).await,
        (Some("view"), Some(file)) => view(file),
        _ => {
            eprintln!("Usage: flatbed chat <agent> | flatbed view <session-file>");
            std::process::exit(2);
        }
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
