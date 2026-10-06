# Providers

A provider turns flatbed's context and messages into one API's request, and the response back into an assistant message. Keep each one to a single small file of translation over plain HTTP.

## The interface

```ts
complete(request) -> assistant message
```

The request holds:

- `model`: the model name, without the provider prefix
- `sections` and `tools`, from the session's `context` entry
- `messages`, rendered as [sessions.md](sessions.md) describes
- `maxTokens`, 8,192 unless the agent sets it
- `outputSchema`, optional: a JSON Schema the response's text must match, for structured output
- `effort`, optional: how much effort the model should spend, such as `low` or `high`, passed through from the agent's config to providers that take it and ignored by the rest
- `signal`, optional, to cancel the request

The response is an assistant message with `model` set to `<provider>/<model-name>`, its `usage` and its `stop`. Map the API's stop reasons to `end`, `toolUse`, `maxTokens` or `refusal`, and any reason not listed for the provider below to `end`.

A provider retries rate limits and server errors itself, three times with backoff, and then throws. When the signal is aborted, it stops at once, during a backoff wait too, and throws.

## Every implementation has

- **`faux`**, a scripted fake for tests. It is given a list of assistant messages, or functions that receive the request and return one, and returns them in order. It records every request it receives. When the list runs out, it throws `No more scripted responses.` It sets `model` to `faux/<model-name>`, and reports `usage` as given in the script, or zero, and `stop` as given, or `toolUse` when the content has a tool call and `end` otherwise.
- **`anthropic`**, the Messages API, described below.

### The Anthropic adapter

- **Sections** become system blocks, in order.
- **Tool results**: `tool` messages move into user messages as `tool_result` blocks. In a user message that holds both, the `tool_result` blocks come first, keeping their order, since the API rejects anything before them.
- **Empty text**: drop every text block whose text is empty, in the system prompt, in messages and inside tool results, since the API rejects them. Give a `tool_result` left with no blocks one text block, `(no output)`. Leave out a message left with no content, such as the assistant message a failed call leaves.
- **Thinking** blocks go back only when they came from Anthropic, with their `signature` when they have one.
- **Structured output**: for `outputSchema`, send `output_config: {format: {type: "json_schema", schema}}` rather than a forced tool call, which recent models refuse. The API wants `additionalProperties: false` on every object in the schema.
- **Effort**: send `effort` as `output_config.effort`, beside `format` when both are given.
- **Stops**: `tool_use` is `toolUse`, `max_tokens` is `maxTokens`, `refusal` is `refusal`, and anything else, such as `end_turn` or `pause_turn`, is `end`.

**Cache breakpoints.** The API allows at most four per request, and caches the prefix in the order tools, system, messages. Use them so:

1. One on the conversation history: set `cache_control: {type: "ephemeral"}` at the top level of the request, which the API applies to the last block it can cache. Each turn then reads the history so far from the cache rather than paying for all of it.
2. One on the last tool, when there are tools.
3. The rest, two or three, on the sections marked `cache: true`, taking the earliest first. Earlier sections change least, so their breakpoints still match after a reset, while the history breakpoint covers the later ones within a session. Mark no more than that, even when more sections ask for it.

TypeScript also has **`openai`**, for any chat-completions-compatible endpoint, which joins the sections into one system message, sends `effort` as `reasoning_effort`, and maps `tool_calls` to `toolUse`, `length` to `maxTokens` and `content_filter` to `refusal`.

## Choosing a provider

An agent names its model as `<provider>/<model-name>`, such as `anthropic/claude-opus-5-5` or `faux/test`. The host gives the loop a map from provider name to provider. When the map has no provider for the agent's model, the run fails before it touches the session, since no model call could succeed.
