//! One error type for the whole crate: a message for a person to read. flatbed reports errors to
//! the model and the host as text, so nothing needs to match on their kind.

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct Error(pub String);

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(message: impl Into<String>) -> Error {
        Error(message.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Error {
        Error(error.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Error {
        Error(error.to_string())
    }
}

impl From<String> for Error {
    fn from(message: String) -> Error {
        Error(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Error {
        Error(message.to_string())
    }
}
