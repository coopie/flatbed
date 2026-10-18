//! A scripted fake provider for tests. It returns its scripted responses in order, records every
//! request it receives, and fails with `No more scripted responses.` when the script runs out.

use super::{Provider, Request};
use crate::error::{Error, Result};
use crate::types::{AssistantMessage, Block, Stop, Usage};
use async_trait::async_trait;
use futures_util::future::BoxFuture;
use std::collections::VecDeque;
use std::sync::Mutex;

/// One scripted response. `usage` defaults to zero, and `stop` to `toolUse` when the content has
/// a tool call and `end` otherwise.
#[derive(Clone, Debug, Default)]
pub struct Scripted {
    pub content: Vec<Block>,
    pub usage: Option<Usage>,
    pub stop: Option<Stop>,
}

/// A scripted function: the response to a request, or the error the call fails with. It may take
/// as long as it likes, or never answer.
pub type Respond = Box<dyn Fn(&Request) -> BoxFuture<'static, Result<Scripted>> + Send + Sync>;

pub enum Script {
    Response(Scripted),
    /// A function of the request, for a response that depends on what the model was sent, or
    /// for a call that fails or hangs.
    Function(Respond),
}

pub struct Faux {
    script: Mutex<VecDeque<Script>>,
    requests: Mutex<Vec<Request>>,
}

impl Faux {
    pub fn new(script: Vec<Script>) -> Faux {
        Faux {
            script: Mutex::new(script.into()),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// Every request received so far, in order.
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().expect("faux lock").clone()
    }
}

#[async_trait]
impl Provider for Faux {
    async fn complete(&self, request: &Request) -> Result<AssistantMessage> {
        self.requests
            .lock()
            .expect("faux lock")
            .push(request.clone());
        let next = self.script.lock().expect("faux lock").pop_front();
        let scripted = match next {
            Some(Script::Response(scripted)) => scripted,
            Some(Script::Function(respond)) => respond(request).await?,
            None => return Err(Error::new("No more scripted responses.")),
        };
        let has_call = scripted
            .content
            .iter()
            .any(|block| matches!(block, Block::ToolCall(_)));
        let default_stop = if has_call { Stop::ToolUse } else { Stop::End };
        Ok(AssistantMessage {
            content: scripted.content,
            model: format!("faux/{}", request.model),
            usage: scripted.usage.unwrap_or_default(),
            stop: scripted.stop.unwrap_or(default_stop),
        })
    }
}
