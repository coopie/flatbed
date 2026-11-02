# @flatbed/resources

Give an agent structured state that the system acts on, such as its schedule or what each session opens with, as resources it reads as plain JSON and changes with JSON Patch. Documents, in `@flatbed/docs`, stay for prose the agent thinks with. A resource is for state the host reads and acts on, where a broken value would break something.

Each resource has a schema, and may have a check for what a schema cannot say. A change is applied to a copy and checked as a whole: either it is saved as the next version, or the agent gets every problem at once and nothing changes. There is no draft and no separate commit, so what the agent last read or saved is what is there. An edit made against an older version is refused with a reason to read again, so neither the agent nor the host can overwrite a change it never saw.

## A resource

A resource is defined in code:

```ts
import type { Resource } from '@flatbed/resources';

type Schedule = Record<string, { cron: string; prompt: string; lastRun?: string }>;

const schedule: Resource<Schedule> = {
  name: 'schedule',
  guide: 'What wakes you, keyed by an id you choose, such as weekly-plan. Each entry has a five-field cron expression and the prompt you wake with. The host sets lastRun when an entry fires.',
  schema: {
    type: 'object',
    additionalProperties: {
      type: 'object',
      properties: { cron: { type: 'string' }, prompt: { type: 'string', minLength: 1 }, lastRun: { type: 'string', readOnly: true } },
      required: ['cron', 'prompt'],
      additionalProperties: false,
    },
  },
  initial: {},
  check: (next) => Object.entries(next).flatMap(([id, w]) => (w.cron.split(' ').length === 5 ? [] : [`/${id}/cron must have five fields.`])),
  views: { prompts: (value) => Object.fromEntries(Object.entries(value).map(([id, w]) => [id, w.prompt])) },
  onChange: ({ value }) => reschedule(value),
};
```

- `name`: lower-case words joined by hyphens.
- `guide`: a few sentences to the agent on what it is for, shown in the context. Write it as [writing.md](../../../docs/ways-of-working/writing.md) describes.
- `schema`: a JSON Schema, draft 2020-12, checked by [@cfworker/json-schema](https://github.com/cfworker/cfworker/tree/main/packages/json-schema), which runs in a browser and a Cloudflare Worker because it never compiles code from strings. Each failure is reported once, at the deepest place it applies, with its path written as a patch would write it.
- `initial`: the value before anything is written, which reads as version 0.
- `check(next, previous, writer)`: every problem with a value that passed the schema, as sentences to the agent, or none. It may be async, so a supervisor can be the check. `writer.tool` is the tool call's context when the agent is writing, such as to read the session.
- `views`: named functions from the value to what a read shows. The one named `default`, if there is one, is what a read with no view shows; otherwise a read shows the whole value. A patch always addresses the whole value, so views that keep its shape, such as a slice of a keyed collection, show paths the agent can patch.
- `onChange`: called after every saved change, by the agent or the host.
- `plugin(self)`: hooks of the resource's own, run as part of the resources plugin, such as context made from its value. `self.read()` gives the value, and `self.problems(value)` checks one. The startup resource below uses it.

**Fields marked `readOnly: true` belong to the host.** An edit by the agent that would set, change or remove one is refused. A field is compared only where the object that holds it is still there, so the agent can still remove a whole entry. The check follows `properties`, `patternProperties`, `additionalProperties`, `prefixItems` and `items`, and not `$ref`, `allOf`, `anyOf` or `oneOf`, so keep host fields where it can find them.

**Collections keyed by id suit resources best,** such as `{"weekly-plan": {...}, "bins": {...}}`. A patch path such as `/weekly-plan/prompt` then names the same entry whatever else changes, and `readOnly` fields are compared by key. In a list they are compared by position, so removing an early item looks like a change to every host field after it. Use a list where order matters, as startup does.

## Setting it up

```ts
import { createAgent } from '@flatbed/core';
import { docsPlugin } from '@flatbed/docs';
import { createResources, resourcesPlugin } from '@flatbed/resources';
import { fileResourceStore } from '@flatbed/resources/node';

const resources = createResources(fileResourceStore('data/resources/wren'), [schedule]);
const agent = createAgent({ id: 'wren', model: 'anthropic/claude-opus-5-5', plugins: [resourcesPlugin(resources), docsPlugin({ store })] }, host);
```

A `ResourceStore` keeps every version of each resource, and has three calls: `get(name)`, `put(name, value, expectedVersion, by)`, which saves the next version or returns undefined when the newest is not `expectedVersion`, and `history(name)`. `memoryResourceStore()` keeps them in memory, and `fileResourceStore(root)`, from `@flatbed/resources/node`, keeps one JSONL file per resource, one version per line. On another database, store one row per version keyed by agent, name and version, and make `put` refuse a version that exists, such as with a unique key.

`createResources` checks each definition, and that each initial value fits its schema, and throws if one does not.

## What the agent sees

A `resources` section lists each resource with its guide and its views, after a short explanation of reading and patching. Sections a resource's own hooks add follow it.

- `read_resource(name, view?)` shows the value, or the view, as indented JSON after a line with its version.
- `edit_resource(name, version, patch)` applies a JSON Patch, [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902), to the version the agent read. A patch that cannot apply, such as a path that is not there, is refused with the first failed operation and what is there instead, such as the members an object has. Then the schema, the `readOnly` fields and `check` are applied, and every problem is listed at once.

## The host

The host reads and writes through the same library:

```ts
const { value, version } = await resources.read('schedule');
await resources.edit('schedule', version, [{ op: 'add', path: '/weekly-plan/lastRun', value: firedAt }], { by: 'host', host: true });
```

`edit` takes a patch and `write` a whole value. Both check the schema and `check`, and with `host: true` they may change `readOnly` fields. A result is `{ saved, previous }`, or `{ problems, current }` with `stale: true` when the version was not the newest; read again and retry. Every saved change, the agent's or the host's, reaches `onChange`.

## startup

`startupResource` decides what each session opens with, in place of pinning. It is a pattern from Sam's contracting work: a list of tool calls, kept by the agent. Reads that belong in every session become the system prompt, and everything else arrives as calls the agent seems to have made itself, with their real results, so material reads as material rather than as instructions.

```json
[
  { "name": "read_doc", "input": { "name": "soul" }, "system": true, "fixed": true },
  { "name": "read_doc", "input": { "name": "guidelines/notes" }, "system": true },
  { "name": "read_doc", "input": { "name": "notes/open-threads" } },
  { "name": "list_docs", "input": { "prefix": "people/" } }
]
```

- `system` entries come first, and each reads one document with `read_doc`. They become sections, in order, after the resources section, and the last carries the cache mark.
- Every other entry becomes one of the core's opening calls, as [the loop spec](../../../docs/spec/loop.md) describes under "Opening calls". It runs through every plugin's `beforeTool` and `afterTool`, as any call does, and may name any tool the agent has.
- `fixed` entries are the host's, kept in code. A document a fixed `read_doc` reads is read-only to the agent: `write_doc` and `edit_doc` refuse it and say why.

```ts
const docs = fileDocStore('data/docs/wren');
const resources = createResources(fileResourceStore('data/resources/wren'), [
  startupResource({ docs, fixed: [{ name: 'read_doc', input: { name: 'soul' }, system: true }] }),
]);
const plugins = [resourcesPlugin(resources), docsPlugin({ store: docs, pinning: false })];
```

Give the docs plugin `pinning: false`, so that there is no `pin_doc`, seeds are written unpinned, and its guide and `read_doc` no longer mention pinning. If the docs plugin has folders, give `startupResource` the same `folders`, so that a system read of a sealed document stays empty. List the resources plugin first, so that the system reads come before the docs plugin's guide and timeline, and so that its refusal of writes to fixed documents runs before any guard that might hold a write.

Its initial value is the fixed entries. An edit is refused, with every problem at once, when it puts a `system` entry after one that is not, has a `system` entry that is not a `read_doc` of one document, calls a tool the agent does not have in the session it edits from, calls `reset`, which would end every session as it opened, or drops, changes, reorders or adds a fixed entry. A change reaches the agent from its next session. A stored value that no longer passes when a session opens, such as after the host changed its fixed entries, is set aside for that session: it opens with the fixed entries alone, and a `startup-problems` section says what to fix. A system read of a document that does not exist, or is in a sealed folder, gives an empty `<doc name="..." missing="true">`. `startupProblems` is exported for a host that wants the same check elsewhere, such as in a dashboard.

A host moving from the docs plugin's old `startup` option can copy the body of its `startup.json` document into the store once, as version 1: `await store.put('startup', JSON.parse(doc.body), 0, 'host')`.

## Live test

`live.test.ts` runs one session on `claude-opus-5-5` with thinking: the agent reads a schedule and startup, patches both, has its schedule edit refused as stale because the host fired an entry in between, reads again and patches correctly. Run it with `FLATBED_LIVE=1 node --test live.test.ts` from this folder, with `.env` at the repo root.
