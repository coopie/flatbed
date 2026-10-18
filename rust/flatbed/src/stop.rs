//! The stop a host makes before a run and sets, with who stopped it, from any task or thread, as
//! docs/spec/host.md describes. Everything in the core that waits, such as a model call, a backoff
//! or a tool, can race its work against `stopped()`, so a stop reaches it at once.

use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Default)]
pub struct StopSignal {
    token: CancellationToken,
    who: Arc<Mutex<Option<String>>>,
}

impl StopSignal {
    pub fn new() -> StopSignal {
        StopSignal::default()
    }

    /// Sets the stop. The first to stop a run names it.
    pub fn stop(&self, who: impl Into<String>) {
        self.who
            .lock()
            .expect("stop signal lock")
            .get_or_insert(who.into());
        self.token.cancel();
    }

    /// Who stopped the run, once it is stopped.
    pub fn stopped_by(&self) -> Option<String> {
        self.who.lock().expect("stop signal lock").clone()
    }

    pub fn is_set(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Finishes when the stop is set, at once when it already is.
    pub async fn stopped(&self) {
        self.token.cancelled().await
    }
}
