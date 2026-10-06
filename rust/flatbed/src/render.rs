//! Turns a session into what the model sees: the path from the root to the head, then the
//! context and messages rendered from it, as docs/spec/sessions.md describes.

use crate::types::{Block, Entry, EntryBody, Event, Message, Section, ToolDefinition, UserMessage};
use std::collections::HashMap;

/// The entries from the root to the head, found by following `parentId` back from the last
/// entry in the file. Entries a rewind left behind are not on it.
pub fn path_of(entries: &[Entry]) -> Vec<&Entry> {
    let by_id: HashMap<&str, &Entry> = entries.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut path = Vec::new();
    let mut next = entries.last();
    while let Some(entry) = next {
        // A parent is always an earlier entry, so a longer path means a corrupt file with a cycle.
        assert!(
            path.len() < entries.len(),
            "the session's parent links form a cycle"
        );
        path.push(entry);
        next = entry
            .parent_id
            .as_deref()
            .and_then(|id| by_id.get(id).copied());
    }
    path.reverse();
    path
}

/// The frozen context the model is given, from the last `context` entry on the path.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Context {
    pub sections: Vec<Section>,
    pub tools: Vec<ToolDefinition>,
}

pub fn render(path: &[&Entry]) -> (Context, Vec<Message>) {
    let mut context = Context::default();
    let mut messages: Vec<Message> = Vec::new();
    for entry in path {
        let message = match &entry.body {
            EntryBody::Context { sections, tools } => {
                context = Context {
                    sections: sections.clone(),
                    tools: tools.clone(),
                };
                continue;
            }
            EntryBody::Message { message } => message.clone(),
            EntryBody::Event(event) => Message::User(UserMessage {
                content: vec![Block::text(render_event(event))],
            }),
            EntryBody::Reset { .. } | EntryBody::Custom { .. } => continue,
        };
        // Neighbouring user messages merge into one, keeping their blocks in order.
        match (messages.last_mut(), message) {
            (Some(Message::User(last)), Message::User(next)) => last.content.extend(next.content),
            (_, message) => messages.push(message),
        }
    }
    (context, messages)
}

/// An event as an XML element named by its kind, such as
/// `<message from="Sam">Can you move my 3pm?</message>`.
pub fn render_event(event: &Event) -> String {
    let mut attrs = String::new();
    // `attrs` is a BTreeMap, so the attributes come out sorted by key.
    for (key, value) in event.attrs.iter().flatten() {
        attrs.push_str(&format!(
            " {key}=\"{}\"",
            escape(value).replace('"', "&quot;")
        ));
    }
    let kind = &event.kind;
    format!("<{kind}{attrs}>{}</{kind}>", escape(&event.text))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
