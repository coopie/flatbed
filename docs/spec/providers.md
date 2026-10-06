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
- `signal`, optional, to cancel the request

The response is an assistant message with `model` set to `<provider>/<model-name>`, its `usage` and its `stop`.

A provider retries rate limits and server errors itself, three times with backoff, and then throws.

## Every implementation has

- **`faux`**, a scripted fake for tests. It is given a list of assistant messages, or functions that receive the request and return one, and returns them in order. It records every request it receives. When the list runs out, it throws `No more scripted responses.` It reports `usage` as given in the script, or zero.
- **`anthropic`**, the Messages API. It sends sections as system blocks, with a cache breakpoint after each section marked `cache: true` and after the tool list. It moves `tool` messages into user messages as `tool_result` blocks. It sends thinking blocks back only when they came from Anthropic. For `outputSchema`, it uses the API's structured output format rather than a forced tool call, which recent models refuse.

TypeScript also has **`openai`**, for any chat-completions-compatible endpoint, which joins the sections into one system message.

## Choosing a provider

An agent names its model as `<provider>/<model-name>`, such as `anthropic/claude-opus-5-5` or `faux/test`. The host gives the loop a map from provider name to provider.
