//! Reads settings from `.env` at the repo root, for the CLI and the live check. It returns values
//! to code and never prints them.

use std::path::PathBuf;

/// The repo root, found from where this crate sits in it: `rust/flatbed/`.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// One value from `.env` at the repo root, falling back to the process environment.
pub fn read_env(name: &str) -> Option<String> {
    let text = std::fs::read_to_string(repo_root().join(".env")).unwrap_or_default();
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == name {
            let value = value.trim();
            let unquoted = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')));
            return Some(unquoted.unwrap_or(value).to_string());
        }
    }
    std::env::var(name).ok()
}
