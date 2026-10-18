//! The OpenAI adapter's translation, both ways, without calling the API.

use flatbed::providers::openai::{from_openai, openai_request};
use flatbed::{Message, Request, Section, Stop, ToolDefinition};
use serde_json::json;

#[test]
fn translates_a_request_for_the_api() {
    let messages: Vec<Message> = serde_json::from_value(json!([
        {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
        {"role": "assistant", "content": [], "model": "openai/x", "usage": {"input": 0, "output": 0}, "stop": "error"},
        {"role": "assistant", "content": [
            {"type": "thinking", "text": "Dropped."},
            {"type": "toolCall", "id": "c1", "name": "echo", "input": {"text": "x"}}
        ], "model": "openai/x", "usage": {"input": 1, "output": 1}, "stop": "toolUse"},
        {"role": "tool", "callId": "c1", "name": "echo", "content": [{"type": "text", "text": "no"}], "isError": true}
    ]))
    .unwrap();
    let section = |text: &str| Section {
        name: "s".into(),
        text: text.into(),
        cache: None,
    };
    let body = openai_request(&Request {
        model: "gpt-x".into(),
        sections: vec![section("One."), section("Two.")],
        tools: vec![ToolDefinition {
            name: "echo".into(),
            description: "Echo the text.".into(),
            input_schema: json!({"type": "object"}),
        }],
        messages,
        max_tokens: 100,
        output_schema: None,
        effort: Some("low".into()),
        signal: None,
    });
    assert_eq!(
        body,
        json!({
            "model": "gpt-x",
            "max_tokens": 100,
            "reasoning_effort": "low",
            "messages": [
                {"role": "system", "content": "One.\n\nTwo."},
                {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
                {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "echo", "arguments": "{\"text\":\"x\"}"}}
                ]},
                {"role": "tool", "tool_call_id": "c1", "content": "Error: no"}
            ],
            "tools": [{"type": "function", "function": {"name": "echo", "description": "Echo the text.", "parameters": {"type": "object"}}}]
        })
    );
}

#[test]
fn reads_a_response() {
    let response = json!({
        "choices": [{
            "message": {"content": "Sure.", "tool_calls": [{"id": "t1", "function": {"name": "echo", "arguments": "{\"text\":\"x\"}"}}]},
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 4}}
    });
    let message = from_openai(&response, "gpt-x").unwrap();
    assert_eq!(
        serde_json::to_value(&message).unwrap(),
        json!({
            "content": [
                {"type": "text", "text": "Sure."},
                {"type": "toolCall", "id": "t1", "name": "echo", "input": {"text": "x"}}
            ],
            "model": "openai/gpt-x",
            "usage": {"input": 6, "output": 5, "cacheRead": 4},
            "stop": "toolUse"
        })
    );
    let stop = |reason: &str| {
        let response = json!({"choices": [{"message": {"content": ""}, "finish_reason": reason}]});
        from_openai(&response, "m").unwrap().stop
    };
    assert_eq!(stop("length"), Stop::MaxTokens);
    assert_eq!(stop("content_filter"), Stop::Refusal);
    assert_eq!(stop("stop"), Stop::End);
}
