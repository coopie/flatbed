# @flatbed/docs

Give an agent a set of Markdown documents in place of a system prompt. Some are written for the agent, such as its soul and its note-taking guidelines. The rest it keeps itself, such as notes on people and a daily timeline. The documents pinned to the agent become its context when a session opens, so what it wrote down yesterday is what it knows today, and a reset loses nothing that was written.

## Documents

A document has a path-like name, such as `soul`, `people/tomas-reyes` or `timeline/2026-10-06`, a Markdown body, a one-line summary, and a `pinned` flag. Every write adds a version and keeps the ones before it, with when and by whom each was written, so a person can see how the agent's memory changed and undo a bad edit.

A `DocStore` holds one agent's documents. It has four calls: `get`, `list`, `put` and `history`. `memoryDocStore()` keeps them in memory, and `fileDocStore(root)`, from `@flatbed/docs/node`, keeps one JSONL file per document, one version per line. On another database, such as IndexedDB in a browser, store one row per version, keyed by agent, name and version.

## What the agent sees

When a session opens, the plugin adds these sections, in this order:

1. `documents`: a short guide to how the documents work and how to keep them.
2. Each pinned document, sorted by name, as `<doc name="..." summary="...">body</doc>`, with the body escaped as the core escapes event text, so a body cannot close its element. The last one is marked `cache: true`.
3. `timeline`: today's timeline document in full, after one summary line for each of the six days before it that has one.

The order runs from stable to volatile, because providers cache the start of the context. The guide never changes, the pinned documents change when the agent edits or pins one, and the timeline changes every day. With the cache mark on the last pinned document, a new day pays again only for the timeline.

The only time in the context is the session's day. The plugin takes it once, from the session header, so the same documents always give the same bytes, and a session resumed later still has the day it opened on. The current time reaches the agent through events.

The agent gets six tools: `list_docs`, `read_doc`, `write_doc`, `edit_doc` (replace one exact passage), `pin_doc` (pin or unpin, from the next session) and `add_to_timeline`. `read_doc` shows a document escaped, as the context does, and `edit_doc` accepts a passage quoted in that form. Each answers in one line where it can. A failure is a result that says what to do differently.

When a session ends, the plugin does nothing. The agent's own notes are its memory, and the guide tells it to bring them up to date before it resets.

## Setting it up

Give each agent its own store and its own plugin. Seed documents are written only when the store has none by that name, so a new agent starts with them and an existing agent keeps its own.

```ts
import { createAgent, anthropicProvider } from '@flatbed/core';
import { fileStore } from '@flatbed/core/node';
import { docsPlugin } from '@flatbed/docs';
import { exampleSeeds, fileDocStore } from '@flatbed/docs/node';

const docs = docsPlugin({
  store: fileDocStore('data/docs/wren'),
  seeds: await exampleSeeds(),
});

const agent = createAgent(
  { id: 'wren', model: 'anthropic/claude-opus-5-5', plugins: [docs] },
  { store: fileStore('data/sessions'), providers: { anthropic: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }) } },
);
```

`exampleSeeds()` returns an invented soul and note-taking guidelines from [seeds/](seeds/), both pinned. Write your own the same way: to the agent, in the second person, as [writing.md](../../../docs/ways-of-working/writing.md) describes. A seed is pinned unless it says `pinned: false`.

By default the session's day is the host's local date when the session opened. Pass `today: (session) => '2026-10-06'` to set it, such as from the user's timezone.

`@flatbed/docs` loads in a browser. What needs Node, the file store and `exampleSeeds()`, is in `@flatbed/docs/node`, as the session file store is in `@flatbed/core/node`.

## Folders

A host can give the agent folders, each with a mode, so that some documents are the agent's to keep and others are not. A document belongs to the folder whose path starts its name, the longest one when folders nest. A document outside every folder behaves as if there were no folders.

- `read`: the agent can list and read. Its tools refuse to write, edit or pin, with a result that says why and names the folders it can write in. The host writes here, such as with seeds or by putting to the store.
- `write`: the agent reads and writes freely, as outside any folder.
- `reviewed`: the same as `write` for this plugin. The host checks each write before it lands, such as with the supervisor's guard, as below. Without a check it is a `write` folder.
- `sealed`: absent from the agent's listing and reading, and its pinned documents stay out of the context. Its tools refuse to write there.

```ts
const folders: Folder[] = [
  { path: 'evidence', mode: 'read', about: 'The physical facts of the case.' },
  { path: 'casebook', mode: 'reviewed', about: "Watson's account, which readers see." },
  { path: 'solution', mode: 'sealed', about: 'What really happened.' },
];
const docs = docsPlugin({ store, folders: () => folders.map((f) => (unsealed.has(f.path) ? { ...f, mode: 'read' } : f)) });
```

When folders are declared, a `folders` section follows the guide. It explains the modes in use and lists each folder with its mode and its `about`. Sealed folders are listed too, so the agent knows that something exists it cannot see yet, and does not invent it.

`folders` is a list, or a function that gives the list when a session opens. To unseal a folder, give it another mode from your function, as above. The plugin reads the folders when it builds a session's tools, so the change reaches the agent from its next session. One exception: when a later process resumes a session, such as after a page reload, the tools are built again and see the new modes, while the context still shows the old ones.

### Reviewed folders and the supervisor

The docs plugin knows nothing of the supervisor. Two exports let a host join them:

- `writeTarget(call)` is the name of the document a `write_doc` or `edit_doc` call would write, or undefined for any other call.
- `afterWrite(store, call)` is that document as the call would leave it, with the whole body, or undefined when the call would fail. Give it to the supervisor so that it judges the whole document, not only the passage an edit changes.

```ts
const guard = supervisorGuard({
  mode: 'enforce',
  supervise,
  specs: (call) => (writeTarget(call)?.startsWith('casebook/') ? casebookSpec : undefined),
  references: async (call) => {
    const after = await afterWrite(store, call);
    const solution = await store.get('solution/culprit');
    return [
      ...(after ? [{ name: `${after.name} after this call`, text: renderDoc(after) }] : []),
      ...(solution ? [{ name: solution.name, text: renderDoc(solution) }] : []),
    ];
  },
});
```

List the guard after the docs plugin. A refused write comes back to the agent with each failed check, and the agent can redraft and write again.
