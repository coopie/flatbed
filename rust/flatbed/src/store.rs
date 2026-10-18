//! Where sessions live. Sessions are only ever created and appended to. The file store keeps each
//! session as `<root>/<agent>/<session>.jsonl`, one JSON object per line, as
//! docs/spec/sessions.md describes. The memory store keeps the same objects in a map, for tests.
//! Both are async, as everything in the core is, so a store on a remote database fits too.

use crate::error::{Error, Result};
use crate::types::{Entry, Header, Session};
use async_trait::async_trait;
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;

#[async_trait]
pub trait Store: Send + Sync {
    /// The agent's session ids, oldest first.
    async fn list(&self, agent: &str) -> Result<Vec<String>>;
    async fn read(&self, agent: &str, session: &str) -> Result<Session>;
    async fn create(&self, header: &Header) -> Result<()>;
    async fn append(&self, agent: &str, session: &str, entry: &Entry) -> Result<()>;
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

#[async_trait]
impl Store for FileStore {
    async fn list(&self, agent: &str) -> Result<Vec<String>> {
        let mut names = match fs::read_dir(self.root.join(agent)).await {
            Ok(names) => names,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut ids = Vec::new();
        while let Some(name) = names.next_entry().await? {
            let name = name.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".jsonl") {
                ids.push(id.to_string());
            }
        }
        ids.sort();
        Ok(ids)
    }

    async fn read(&self, agent: &str, session: &str) -> Result<Session> {
        parse_session(&fs::read_to_string(self.file(agent, session)).await?)
    }

    async fn create(&self, header: &Header) -> Result<()> {
        fs::create_dir_all(self.root.join(&header.agent)).await?;
        // `create_new` refuses to overwrite a session that already exists.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.file(&header.agent, &header.id))
            .await?;
        file.write_all(line(header)?.as_bytes()).await?;
        Ok(())
    }

    async fn append(&self, agent: &str, session: &str, entry: &Entry) -> Result<()> {
        let mut file = OpenOptions::new()
            .append(true)
            .open(self.file(agent, session))
            .await?;
        file.write_all(line(entry)?.as_bytes()).await?;
        Ok(())
    }
}

/// One JSON object and its newline, written in one call so that a line is never split.
fn line(value: &impl serde::Serialize) -> Result<String> {
    Ok(serde_json::to_string(value)? + "\n")
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
    sessions: Mutex<BTreeMap<String, BTreeMap<String, Session>>>,
}

impl MemoryStore {
    pub fn new() -> MemoryStore {
        MemoryStore::default()
    }
}

#[async_trait]
impl Store for MemoryStore {
    async fn list(&self, agent: &str) -> Result<Vec<String>> {
        let sessions = self.sessions.lock().expect("store lock");
        Ok(sessions
            .get(agent)
            .map(|by_id| by_id.keys().cloned().collect())
            .unwrap_or_default())
    }

    async fn read(&self, agent: &str, session: &str) -> Result<Session> {
        let sessions = self.sessions.lock().expect("store lock");
        sessions
            .get(agent)
            .and_then(|by_id| by_id.get(session))
            .cloned()
            .ok_or_else(|| Error(format!("No session {agent}/{session}.")))
    }

    async fn create(&self, header: &Header) -> Result<()> {
        let mut sessions = self.sessions.lock().expect("store lock");
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

    async fn append(&self, agent: &str, session: &str, entry: &Entry) -> Result<()> {
        let mut sessions = self.sessions.lock().expect("store lock");
        let found = sessions
            .get_mut(agent)
            .and_then(|by_id| by_id.get_mut(session))
            .ok_or_else(|| Error(format!("No session {agent}/{session}.")))?;
        found.entries.push(entry.clone());
        Ok(())
    }
}
