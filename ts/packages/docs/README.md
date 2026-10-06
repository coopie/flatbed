# @flatbed/docs

Give an agent a set of Markdown documents in place of a system prompt. Some are written for the agent, such as its soul and its note-taking guidelines. The rest it keeps itself, such as notes on people and a daily timeline. The documents pinned to the agent become its context when a session opens, so what it wrote down yesterday is what it knows today, and a reset loses nothing that was written.

## Documents

A document has a path-like name, such as `soul`, `people/tomas-reyes` or `timeline/2026-10-06`, a Markdown body, a one-line summary, and a `pinned` flag. Every write adds a version and keeps the ones before it, with when and by whom each was written, so a person can see how the agent's memory changed and undo a bad edit.

A `DocStore` holds one agent's documents. It has four calls: `get`, `list`, `put` and `history`. `memoryDocStore()` is for tests, and `fileDocStore(root)` keeps one JSONL file per document, one version per line. On another database, store one row per version, keyed by agent, name and version.

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
import { createAgent, anthropicProvider, fileStore } from '@flatbed/core';
import { docsPlugin, exampleSeeds, fileDocStore } from '@flatbed/docs';

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
