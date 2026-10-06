//! Where sessions live. Sessions are only ever created and appended to. The file store keeps each
//! session as `<root>/<agent>/<session>.jsonl`, one JSON object per line, as
//! docs/spec/sessions.md describes. The memory store keeps the same objects in a map, for tests.

use crate::error::{Error, Result};
use crate::types::{Entry, Header, Session};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::PathBuf;

pub trait Store {
    /// The agent's session ids, oldest first.
    fn list(&self, agent: &str) -> Result<Vec<String>>;
    fn read(&self, agent: &str, session: &str) -> Result<Session>;
    fn create(&self, header: &Header) -> Result<()>;
    fn append(&self, agent: &str, session: &str, entry: &Entry) -> Result<()>;
}

pub struct FileStore {
    root: PathBuf,
}

impl FileStore {
    pub fn new(root: impl Into<PathBuf>) -> FileStore {
        FileStore { root: root.into() }
    }

    fn file(&self, agent: &str, session: &str) -> PathBuf {
        self.root.join(agent).join(format!("{session}.jsonl"))
    }
}

impl Store for FileStore {
    fn list(&self, agent: &str) -> Result<Vec<String>> {
        let names = match fs::read_dir(self.root.join(agent)) {
            Ok(names) => names,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut ids = Vec::new();
        for name in names {
            let name = name?.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".jsonl") {
                ids.push(id.to_string());
            }
        }
        ids.sort();
        Ok(ids)
    }

    fn read(&self, agent: &str, session: &str) -> Result<Session> {
        parse_session(&fs::read_to_string(self.file(agent, session))?)
    }

    fn create(&self, header: &Header) -> Result<()> {
        fs::create_dir_all(self.root.join(&header.agent))?;
        // `create_new` refuses to overwrite a session that already exists.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.file(&header.agent, &header.id))?;
        writeln!(file, "{}", serde_json::to_string(header)?)?;
        Ok(())
    }

    fn append(&self, agent: &str, session: &str, entry: &Entry) -> Result<()> {
        let mut file = OpenOptions::new()
            .append(true)
            .open(self.file(agent, session))?;
        writeln!(file, "{}", serde_json::to_string(entry)?)?;
        Ok(())
    }
}

/// Reads a session file's text: a header line, then one entry per line.
pub fn parse_session(text: &str) -> Result<Session> {
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let first = lines.next().ok_or("A session file must not be empty.")?;
    let header: Header = serde_json::from_str(first).map_err(|e| {
        Error(format!(
            "A session file must start with a session header: {e}"
        ))
    })?;
    let entries = lines
        .map(serde_json::from_str)
        .collect::<std::result::Result<Vec<Entry>, _>>()?;
    Ok(Session { header, entries })
}

#[derive(Default)]
pub struct MemoryStore {
    /// Sessions by agent, then by session id, so both iterate in id order.
    sessions: RefCell<BTreeMap<String, BTreeMap<String, Session>>>,
}

impl MemoryStore {
    pub fn new() -> MemoryStore {
        MemoryStore::default()
    }
}

impl Store for MemoryStore {
    fn list(&self, agent: &str) -> Result<Vec<String>> {
        let sessions = self.sessions.borrow();
        Ok(sessions
            .get(agent)
            .map(|by_id| by_id.keys().cloned().collect())
            .unwrap_or_default())
    }

    fn read(&self, agent: &str, session: &str) -> Result<Session> {
        let sessions = self.sessions.borrow();
        sessions
            .get(agent)
            .and_then(|by_id| by_id.get(session))
            .cloned()
            .ok_or_else(|| Error(format!("No session {agent}/{session}.")))
    }

    fn create(&self, header: &Header) -> Result<()> {
        let mut sessions = self.sessions.borrow_mut();
        let by_id = sessions.entry(header.agent.clone()).or_default();
        if by_id.contains_key(&header.id) {
            return Err(Error(format!("Session {} already exists.", header.id)));
        }
        let session = Session {
            header: header.clone(),
            entries: Vec::new(),
        };
        by_id.insert(header.id.clone(), session);
        Ok(())
    }

    fn append(&self, agent: &str, session: &str, entry: &Entry) -> Result<()> {
        let mut sessions = self.sessions.borrow_mut();
        let found = sessions
            .get_mut(agent)
            .and_then(|by_id| by_id.get_mut(session))
            .ok_or_else(|| Error(format!("No session {agent}/{session}.")))?;
        found.entries.push(entry.clone());
        Ok(())
    }
}
