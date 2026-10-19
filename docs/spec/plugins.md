# Plugins and tools

A plugin is how anything beyond the loop joins an agent: documents, supervision, sub-agents, a web page streaming the session. The core knows nothing about any plugin; it calls their hooks at fixed points, in the order the agent lists them.

## A plugin

A plugin is a plain object with a `name` and any of five hooks. Every hook is async, as everything in the core is; TypeScript and Python also accept a hook or tool that returns a plain value.

- **`context(ctx)`**, when a session opens. Returns sections and tools to add. Sections from all plugins are joined in plugin order. When it throws, the run fails before writing anything, with the error `The <plugin> plugin failed: <message>`.
- **`beforeTool(call, ctx)`**, before a tool call runs. Returns nothing to let it run, or a result to use instead, such as a refusal or a note that the call is waiting for a person. The first plugin that returns a result wins, and the tool does not run.
- **`afterTool(call, result, ctx)`**, after a tool call runs or is replaced. May return a changed result, such as one with secrets redacted. Results pass through plugins in order.
- **`onEntry(entry, ctx)`**, after every entry is appended. For watching, such as streaming to a page or writing a timeline. Its return value is ignored, and so is an error it throws, so that a watcher can never leave a turn's results half written.
- **`onSessionEnd(session, ctx)`**, after a `reset` is appended. An error it throws is ignored, since the session has already ended.

`ctx` gives a hook the agent, the open session, the run's stop signal as `signal`, and two actions:

- `append(entry)`, to add a `custom` entry to the open session. It writes at once, before the hook carries on, and fails for any other type of entry.
- `deliver(event)`, to queue an event for the next delivery point

Send events through `deliver`, never `append`. Delivery points come only after a turn's results, so an event never lands between a tool call and its result, which providers reject.

A session's first entry is its `context` entry, so `append` fails in the `context` hook too.

Nothing follows a reset, so `append` fails in `onSessionEnd`. Use `deliver` there instead: the event arrives at the start of the next session, after its `Session started` notice.

A `custom` entry never makes a session need a run, or stop needing one: the loop ignores it, as [loop.md](loop.md) describes.

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
- `ctx` is the plugin context, plus `requestReset(reason)`. Its `signal` lets a long tool, such as a sub-agent or a remote call, stop when the run is stopped. When several calls of a turn request a reset, the first in call order wins, as [loop.md](loop.md) describes.

## Running a tool call

For each call in an assistant message:

1. Find the tool by name in the session's tools. When none matches, the result is an error: `No tool named <name>.`
2. Check the input against the tool's schema, as the session's `context` entry records it, not as the plugin's code has it now. Each implementation checks at least that the input is an object and that required properties are present, and reports the first problem in these words, which the conformance suite checks: `Invalid input for <name>: expected an object.` or `Invalid input for <name>: missing required property "<property>".` A fuller check may report other problems in its own words.
3. Call each plugin's `beforeTool`. When one returns a result, use it.
4. Otherwise call the tool's `run`. When it throws, the result is an error with the message.
5. Pass the result through each plugin's `afterTool`.

When `beforeTool` or `afterTool` throws, the result of that call is an error, `The <plugin> plugin failed: <message>`, where `<plugin>` is the plugin's name. No other hook runs for that call afterwards, so a throwing `beforeTool` also skips every `afterTool`. A custom entry the hook appended before it threw stays in the session. The session stays consistent, every call keeps its own result, and the model learns that something went wrong rather than seeing a misleading repair on the next run.

A custom entry that a tool, `beforeTool` or `afterTool` appends is written at once, so it lands before the turn's `tool` messages, which are appended together after the last call.

A call that fails at step 1 or 2 never reaches the plugins. Nor does a call in a response cut off by `maxTokens`, which the loop answers without running, as [loop.md](loop.md) describes.

The session's `context` entry decides which tools exist; the plugins supply their code. When a session opens and two of its tools would share a name, including a plugin's tool named `reset`, the run fails before writing anything, with the error `Two tools are named <name>.` When a run resumes a session that an earlier process opened, the loop calls the `context` hooks again for the tools' code and ignores the sections.

A session's tools are fixed when it opens, for its whole life, and anything new reaches the model as appended messages. Providers bind signed content and caches to the tools list: on 20 October 2026 a session whose tools changed part way through failed every later call to a thinking model on Anthropic, as [decisions.md](../decisions.md) records under "A session's tools are fixed when it opens".

## A tool that runs other tools

A tool's `ctx` also has `runTool(call)`, for a tool that calls other tools on the model's behalf, such as codemode's `run_script`. It runs the call exactly as the loop runs a call from the model, steps 1 to 5 above, against the session's frozen tools, with the same hooks, schema check and error wording, and returns the result. It appends no `tool` message, since the call is the calling tool's own business; the calling tool records what it needs as `custom` entries.

Calls made with `runTool` share the turn's limit of `maxConcurrentTools` with the model's own calls, so a turn never runs more calls at once than its agent allows. While a tool waits for a call it made with `runTool`, it gives up its own place under the limit and takes one back before it carries on, so a tool that calls others can never wait on a place it is holding itself.

A call made with `runTool` shares its caller's `requestReset`. Once the stop is set, a nested call that has not started gets `The harness stopped before this tool ran.`, as a direct call does. A tool that ends while calls it made are still running takes no place back.

## Tools in other languages

A tool written in another language joins an agent through the `mcp` plugin, which connects to MCP servers when a session opens and adds their tools. The core needs nothing for this.
