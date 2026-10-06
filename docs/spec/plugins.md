# Plugins and tools

A plugin is how anything beyond the loop joins an agent: documents, supervision, sub-agents, a web page streaming the session. The core knows nothing about any plugin; it calls their hooks at fixed points, in the order the agent lists them.

## A plugin

A plugin is a plain object with a `name` and any of five hooks. Every hook may be asynchronous.

- **`context(ctx)`**, when a session opens. Returns sections and tools to add. Sections from all plugins are joined in plugin order.
- **`beforeTool(call, ctx)`**, before a tool call runs. Returns nothing to let it run, or a result to use instead, such as a refusal or a note that the call is waiting for a person. The first plugin that returns a result wins, and the tool does not run.
- **`afterTool(call, result, ctx)`**, after a tool call runs or is replaced. May return a changed result, such as one with secrets redacted. Results pass through plugins in order.
- **`onEntry(entry, ctx)`**, after every entry is appended. For watching, such as streaming to a page or writing a timeline. Its return value is ignored.
- **`onSessionEnd(session, ctx)`**, after a `reset` is appended.

`ctx` gives a hook the agent, the open session, and two actions:

- `append(entry)`, to add a `custom` entry or an `event` to the open session now, such as from `afterTool`
- `deliver(event)`, to queue an event for the next delivery point

Nothing follows a reset, so `append` fails in `onSessionEnd`. Use `deliver` there instead: the event arrives at the start of the next session.

## A tool

A tool is a name, a description, an input schema and a function:

```ts
{
  name: "read_doc",
  description: "Read one of your documents by name. Use it before you change a document.",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  run: async (input, ctx) => ({ content: [{ type: "text", text: "..." }], isError: false })
}
```

- Write the description to say when to call the tool, in the voice of [writing.md](../ways-of-working/writing.md).
- `run` may return a string, which becomes one text block with `isError: false`.
- `ctx` is the plugin context, plus `requestReset(reason)`.

## Running a tool call

For each call in an assistant message:

1. Find the tool by name in the session's tools. When none matches, the result is an error: `No tool named <name>.`
2. Check the input against the tool's schema. Each implementation checks at least that the input is an object and that required properties are present, and reports the first problem in these words, which the conformance suite checks: `Invalid input for <name>: expected an object.` or `Invalid input for <name>: missing required property "<property>".` A fuller check may report other problems in its own words.
3. Call each plugin's `beforeTool`. When one returns a result, use it.
4. Otherwise call the tool's `run`. When it throws, the result is an error with the message.
5. Pass the result through each plugin's `afterTool`.

A call that fails at step 1 or 2 never reaches the plugins.

The session's `context` entry decides which tools exist; the plugins supply their code. When a run resumes a session that an earlier process opened, the loop calls the `context` hooks again for the tools' code and ignores the sections.

## Tools in other languages

A tool written in another language joins an agent through the `mcp` plugin, which connects to MCP servers when a session opens and adds their tools. The core needs nothing for this.
