//! The host surface the conformance suite cannot reach: the words `Agent::new` fails with, and the
//! stop signal's names, as docs/spec/host.md gives them.

use flatbed::providers::faux::Faux;
use flatbed::{Agent, AgentConfig, MemoryStore, Provider, StopSignal};
use std::collections::HashMap;
use std::sync::Arc;

fn new_agent(config: AgentConfig) -> String {
    let providers = HashMap::from([(
        "faux".to_string(),
        Arc::new(Faux::new(Vec::new())) as Arc<dyn Provider>,
    )]);
    match Agent::new(config, Arc::new(MemoryStore::default()), providers) {
        Ok(_) => "made an agent".into(),
        Err(error) => error.0,
    }
}

#[test]
fn agent_new_fails_in_the_words_host_md_gives() {
    assert_eq!(
        new_agent(AgentConfig::new("a", "nowhere/test")),
        "No provider named nowhere for the model nowhere/test."
    );
    let mut config = AgentConfig::new("a", "faux/test");
    config.max_concurrent_tools = 0;
    assert_eq!(
        new_agent(config),
        "max_concurrent_tools must be at least 1, not 0."
    );
}

#[tokio::test]
async fn a_stop_is_set_once_and_wait_finishes_when_it_is() {
    let stop = StopSignal::new();
    assert_eq!(stop.who(), None);
    let setter = stop.clone();
    tokio::spawn(async move { setter.set("Sam") });
    stop.wait().await;
    stop.set("Ana");
    assert_eq!(stop.who().as_deref(), Some("Sam"));
}
