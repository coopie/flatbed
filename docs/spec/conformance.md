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

- `sections` and `tools` come from a test plugin's `context` hook. The runner adds the core `reset` tool after them, as the loop does.
- A tool's `behaviour` is one of `{"echo": "<property>"}` (return that input property as text), `{"text": "..."}`, `{"error": "..."}` (throw with that message), `{"reset": "<reason>"}` (call `requestReset` and return `Session will reset after this turn.`) or `{"deliver": <event>}` (queue the event with `ctx.deliver` and return `Delivered.`).
- `steps` run in order. Each is `{"deliver": <event>}` (queue an event), `{"run": {}}` (with an optional `stop: "<who>"` inside to set the stop signal before the run, and an optional `"expect"` beside it for the run's outcome), `{"crash": <entry>}` (append the entry, without `id`, `parentId` and `at`, straight to the store's newest session after its last entry, with a fresh `id` and `at`, as a crashed process would have), or `{"rewind": <index>}` (give the next delivered event, as its parent, the entry at that 0-based index of the newest session's path).
- `expect.sessions` lists each session the agent has at the end, oldest first, as its entries. The runner compares entries after removing `id`, `parentId` and `at`, and checks separately that each entry's `parentId` names the entry before it, except an event whose parent is a `rewind` target. It compares the header's `parent.reason` when the scenario gives one as `{"header": {"parent": {"reason": "reset"}}}` at the start of a session's list.
- `expect.requests`, when given, lists the `messages` the fake provider received on each call, compared exactly.

## The runner

Each implementation has a runner that loads every scenario, runs it against an in-memory or temporary file store with an agent named `test`, and prints one line per scenario, `ok <name>` or `FAIL <name>: <first difference>`, then exits non-zero on any failure. `scripts/check.sh` runs all three. The TypeScript runner is `node ts/packages/core/conformance.ts`.
