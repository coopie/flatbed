//! A scripted fake provider for tests. It returns its scripted responses in order, records every
//! request it receives, and fails with `No more scripted responses.` when the script runs out.

use super::{Provider, Request};
use crate::error::{Error, Result};
use crate::types::{AssistantMessage, Block, Stop, Usage};
use std::cell::RefCell;
use std::collections::VecDeque;

/// One scripted response. `usage` defaults to zero, and `stop` to `toolUse` when the content has
/// a tool call and `end` otherwise.
#[derive(Clone, Debug, Default)]
pub struct Scripted {
    pub content: Vec<Block>,
    pub usage: Option<Usage>,
    pub stop: Option<Stop>,
}

pub enum Script {
    Response(Scripted),
    /// A function of the request, for a response that depends on what the model was sent.
    Function(Box<dyn Fn(&Request) -> Scripted>),
}

pub struct Faux {
    script: RefCell<VecDeque<Script>>,
    requests: RefCell<Vec<Request>>,
}

impl Faux {
    pub fn new(script: Vec<Script>) -> Faux {
        Faux {
            script: RefCell::new(script.into()),
            requests: RefCell::new(Vec::new()),
        }
    }

    /// Every request received so far, in order.
    pub fn requests(&self) -> Vec<Request> {
        self.requests.borrow().clone()
    }
}

impl Provider for Faux {
    fn complete(&self, request: &Request) -> Result<AssistantMessage> {
        self.requests.borrow_mut().push(request.clone());
        let next = self.script.borrow_mut().pop_front();
        let scripted = match next {
            Some(Script::Response(scripted)) => scripted,
            Some(Script::Function(respond)) => respond(request),
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
