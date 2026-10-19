# Conformance

The conformance suite is how three implementations stay in step without reading each other's code. Each scenario in `conformance/scenarios/` drives the loop with the fake provider and states what must come out. An implementation conforms when its runner passes every scenario.

## A scenario

A scenario is one JSON file:

```json
{
  "name": "tool call then answer",
  "description": "The model calls a tool, sees its result and answers.",
  "agent": { "model": "faux/test", "softLimit": 120000, "hardLimit": 180000 },
  "sections": [{ "name": "soul", "text": "You are a test agent." }],
  "tools": [{ "name": "echo", "description": "Echo the input.", "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }, "behaviour": { "echo": "text" } }],
  "script": [
    { "content": [{ "type": "toolCall", "id": "c1", "name": "echo", "input": { "text": "hi" } }], "stop": "toolUse", "usage": { "input": 10, "output": 5 } },
    { "content": [{ "type": "text", "text": "Done." }], "stop": "end", "usage": { "input": 20, "output": 3 } }
  ],
  "steps": [
    { "deliver": { "kind": "message", "attrs": { "from": "Sam" }, "text": "Say hi" } },
    { "run": {}, "expect": "idle" }
  ],
  "expect": {
    "sessions": [[ "...entries, without id, parentId and at..." ]],
    "requests": [ "...optional: the messages the fake model received on each call..." ]
  }
}
```

- `agent` may also set `maxTokens`, `effort`, `toolExecution`, `maxConcurrentTools`, and `parent`, the parent for the agent's first session, as [host.md](host.md) describes.
- `sections` and `tools` come from a test plugin, named `test`, through its `context` hook, with optional `available` tools, given in the same form as `tools`, for its hook to return as `available`. The runner adds the core `reset` tool after them, as the loop does.
- `plugin`, optional, gives the same test plugin more to do. Each part is optional:
  - `"context": {"append": <data>}`: in the `context` hook, try to `append` a `custom` entry with this `data`, and carry on when that fails; or `"context": {"throw": "<message>"}`: make the `context` hook throw
  - `"beforeTool": {"<tool name>": <result>}`: return that result, as `{"content": [...], "isError": ...}`, for every call to that tool, so the tool does not run
  - `"afterTool": {"<tool name>": <result>}`: replace the result of every call to that tool with this one
  - In either, `{"throw": "<message>"}` in place of a result makes the hook throw an error with that message for every call to that tool
  - `"onEntry": {"custom": <data>}`: after each `tool` message is appended, `append` a `custom` entry with `plugin: "test"` and this `data`; or `"onEntry": {"throw": "<message>"}`: throw instead, where the language lets the hook fail
  - `"onSessionEnd": {"deliver": <event>}`: `deliver` this event when a session ends
- `script` lists the fake provider's responses. An entry may instead be:
  - `{"abort": "<who>"}`: the fake sets the stop signal with that name while the call is in flight, then fails the call
  - `{"hang": true}`: the fake never answers and ignores the signal, so the run ends only if the core abandons the call when the stop is set
- A tool's `behaviour` is one of `{"echo": "<property>"}` (return that input property as text), `{"text": "..."}`, `{"error": "..."}` (throw with that message), `{"reset": "<reason>"}` (call `requestReset` and return `Session will reset after this turn.`), `{"deliver": <event>}` (queue the event with `ctx.deliver` and return `Delivered.`), `{"waitForStop": "<text>"}` (wait until `ctx.signal` is set, then return the text) `{"runTools": [{"name": "<tool>", "input": {...}}, ...]}` (run those calls together with `ctx.runTool` and return their results' text, one per line) or `{"addTools": ["<name>", ...]}` (call `ctx.addTools` with those names and return the names it added, comma-separated, or `none`). Any behaviour may also have `"sleep": <ms>`, to wait that long first, and `"append": <data>`, to `append` a `custom` entry with `plugin: "test"` and this `data` after the wait, such as `{"sleep": 300, "reset": "done"}`. The runner records when every tool call starts and ends, for `expect.maxRunning`, and leaves out the time a `runTools` tool spends waiting for its calls, since it gives up its place then.
- `steps` run in order. Each is `{"deliver": <event>}` (queue an event), `{"run": {}}` (with an optional `stop: "<who>"` inside to set the stop before the run starts, or `stopAfter` milliseconds after it starts when the run also gives `stopAfter`, and an optional `"expect"` beside it for the run's outcome, or `{"error": "<message>"}` when the run must fail with that message, which it compares exactly), `{"crash": <entry>}` (append the entry, without `id`, `parentId` and `at`, straight to the store's newest session after its last entry, with a fresh `id` and `at`, as a crashed process would have), `{"rewind": <index>}` (give the next delivered event, as its parent, the entry at that 0-based index of the newest session's path), or `{"header": {}}` (write the header of a new session to the store and nothing else, as a process that stopped between the two would have: its id sorts after the newest session's, and its parent is the newest session with `reason: "reset"`, or none when the agent has no session).
- `expect.sessions` lists each session the agent has at the end, oldest first, as its entries. The runner compares entries after removing `id`, `parentId` and `at`, and checks separately that each entry's `parentId` names the entry before it, except an event whose parent is a `rewind` target. It compares the header's `parent` when the scenario gives one as `{"header": {"parent": {...}}}` at the start of a session's list, such as `{"header": {"parent": {"reason": "reset"}}}`. The comparison is exact, except that it leaves out `parent.session` when the scenario does, since a scenario cannot know the id of a session the loop made.
- `expect.requests`, when given, lists what the fake provider received on each call. Each item is either the `messages`, compared exactly, or an object with any of `messages`, `sections`, `tools`, `maxTokens` and `effort`, each compared exactly.
- `expect.maxRunning`, when given, is the greatest number of tool calls that were running at once during the scenario. It shows that calls overlap when they should and never when they should not.
- `expect.requests` and `expect.maxRunning` are checked after `expect.sessions`. When `expect.requests` is given, the provider must have received exactly that many requests.

## The runner

Each implementation has a runner that loads every scenario, runs it against an in-memory or temporary file store with an agent named `test`, and prints one line per scenario, `ok <name>` or `FAIL <name>: <first difference>`, then exits non-zero on any failure. A scenario that has not finished after 10 seconds fails, so that a run that never ends, such as one waiting on a hung model call, cannot hang the suite. `scripts/check.sh` runs all three. The TypeScript runner is `node ts/packages/core/conformance.ts`.
