//! The Anthropic adapter's translation, both ways, without calling the API.

use flatbed::providers::anthropic::{anthropic_request, from_anthropic};
use flatbed::{Message, Request, Section, Stop, ToolDefinition};
use serde_json::{json, Value};

fn messages(value: Value) -> Vec<Message> {
    serde_json::from_value(value).unwrap()
}

fn request(messages: Vec<Message>, cached_sections: usize) -> Request {
    Request {
        model: "claude-sonnet-5-5".into(),
        sections: (0..cached_sections)
            .map(|i| Section {
                name: format!("s{i}"),
                text: format!("Section {i}."),
                cache: Some(true),
            })
            .collect(),
        tools: vec![ToolDefinition {
            name: "echo".into(),
            description: "Echo the text.".into(),
            input_schema: json!({"type": "object"}),
        }],
        messages,
        max_tokens: 1024,
        output_schema: None,
        effort: None,
        signal: None,
    }
}

#[test]
fn translates_messages_for_the_api() {
    let body = anthropic_request(&request(
        messages(json!([
            {"role": "user", "content": [{"type": "text", "text": "Hi"}, {"type": "text", "text": ""}]},
            {"role": "assistant", "content": [], "model": "anthropic/x", "usage": {"input": 0, "output": 0}, "stop": "error"},
            {"role": "assistant", "content": [
                {"type": "thinking", "text": "Mine.", "signature": "sig", "provider": "anthropic"},
                {"type": "thinking", "text": "Another provider's."},
                {"type": "toolCall", "id": "c1", "name": "echo", "input": {"text": "x"}}
            ], "model": "anthropic/x", "usage": {"input": 1, "output": 1}, "stop": "toolUse"},
            {"role": "user", "content": [{"type": "text", "text": "<notice>Later.</notice>"}]},
            {"role": "tool", "callId": "c1", "name": "echo", "content": [{"type": "text", "text": "x"}], "isError": false}
        ])),
        0,
    ));
    assert_eq!(
        body["messages"],
        json!([
            {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Mine.", "signature": "sig"},
                {"type": "tool_use", "id": "c1", "name": "echo", "input": {"text": "x"}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c1", "content": [{"type": "text", "text": "x"}], "is_error": false},
                {"type": "text", "text": "<notice>Later.</notice>"}
            ]}
        ])
    );
}

#[test]
fn caps_cache_breakpoints_at_four() {
    let marked = |list: &Value| {
        list.as_array()
            .unwrap()
            .iter()
            .filter(|b| b.get("cache_control").is_some())
            .count()
    };
    // One on the history, one after the tools, and the earliest two cached sections.
    let body = anthropic_request(&request(Vec::new(), 4));
    assert_eq!(body["cache_control"], json!({"type": "ephemeral"}));
    assert_eq!(marked(&body["tools"]), 1);
    assert_eq!(marked(&body["system"]), 2);
    assert!(body["system"][0].get("cache_control").is_some());
    assert!(body["system"][3].get("cache_control").is_none());

    let body = anthropic_request(&request(Vec::new(), 1));
    assert_eq!(marked(&body["system"]), 1);
}

#[test]
fn reads_a_response() {
    let response = json!({
        "content": [
            {"type": "thinking", "thinking": "Hmm.", "signature": "sig"},
            {"type": "text", "text": "Sure."},
            {"type": "tool_use", "id": "t1", "name": "echo", "input": {"text": "x"}}
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 3, "cache_creation_input_tokens": null}
    });
    let message = from_anthropic(&response, "claude-sonnet-5-5").unwrap();
    assert_eq!(
        serde_json::to_value(&message).unwrap(),
        json!({
            "content": [
                {"type": "thinking", "text": "Hmm.", "signature": "sig", "provider": "anthropic"},
                {"type": "text", "text": "Sure."},
                {"type": "toolCall", "id": "t1", "name": "echo", "input": {"text": "x"}}
            ],
            "model": "anthropic/claude-sonnet-5-5",
            "usage": {"input": 10, "output": 5, "cacheRead": 3},
            "stop": "toolUse"
        })
    );
    let stop = |reason: &str| {
        let response = json!({"content": [], "stop_reason": reason, "usage": {"input_tokens": 1, "output_tokens": 1}});
        from_anthropic(&response, "m").unwrap().stop
    };
    assert_eq!(stop("refusal"), Stop::Refusal);
    assert_eq!(stop("max_tokens"), Stop::MaxTokens);
    assert_eq!(stop("pause_turn"), Stop::End);
}
