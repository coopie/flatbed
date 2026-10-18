//! What every provider that calls an API shares: its options, and one POST of JSON with the
//! retry rules in docs/spec/providers.md.

use crate::error::{Error, Result};
use crate::stop::StopSignal;
use serde_json::Value;
use std::time::Duration;

const RETRIES: u32 = 3;

/// The options every provider that calls an API takes.
#[derive(Clone, Debug)]
pub struct ProviderOptions {
    pub api_key: String,
    /// The API's address, when it is not the provider's own, such as a proxy or a local server.
    pub base_url: Option<String>,
    /// How long to wait for a response: 600 seconds unless set.
    pub timeout: Duration,
}

impl ProviderOptions {
    pub fn new(api_key: impl Into<String>) -> ProviderOptions {
        ProviderOptions {
            api_key: api_key.into(),
            base_url: None,
            timeout: Duration::from_secs(600),
        }
    }

    pub(crate) fn client(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(self.timeout)
            .build()
            .expect("an HTTP client with a timeout")
    }
}

/// POSTs `body` and returns the response's JSON. Retries three times, waiting 1, 2 and then 4
/// seconds, when the request got no response or got 408, 409, 429 or 500 and above. A stop ends
/// the request or the wait at once.
pub(crate) async fn post_json(
    request: reqwest::RequestBuilder,
    body: &Value,
    signal: Option<&StopSignal>,
) -> Result<Value> {
    let stop = signal.cloned().unwrap_or_default();
    let stopped = || Error::new("The request was stopped.");
    let mut attempt = 0;
    loop {
        let sent = request
            .try_clone()
            .expect("a JSON body can be sent again")
            .json(body)
            .send();
        let failure = tokio::select! {
            () = stop.wait() => return Err(stopped()),
            response = sent => match response {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let text = response.text().await.unwrap_or_default();
                    if status < 300 {
                        return Ok(serde_json::from_str(&text)?);
                    }
                    let failure = format!("HTTP {status}: {}", truncate(&text, 500));
                    if !matches!(status, 408 | 409 | 429 | 500..) {
                        return Err(Error(failure));
                    }
                    failure
                }
                Err(error) => error.to_string(),
            },
        };
        if attempt == RETRIES {
            return Err(Error(format!("{failure} (after {RETRIES} retries)")));
        }
        tokio::select! {
            () = stop.wait() => return Err(stopped()),
            () = tokio::time::sleep(Duration::from_secs(1 << attempt)) => {}
        }
        attempt += 1;
    }
}

fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}
