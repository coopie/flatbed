# Kickoff: the docs plugin

You are building the plugin that replaces a system prompt with documents. An agent on flatbed keeps a set of Markdown documents: some written for it, such as its soul and its guidelines, and some it maintains itself, such as notes on people and a daily timeline. The documents pinned to it become its context sections when a session opens, so what the agent wrote down yesterday is what it knows today, and a reset loses nothing that was written. Read `AGENTS.md` and the docs it lists, `docs/spec/plugins.md`, the code in `ts/packages/core`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Context

Otherworldly's agent host does this well and is worth reading before you start: `../otherworldly-agent/agent_host/src/host/context.ts` (the layers, ordered from stable to volatile so caching works, and why nothing reads the clock), `src/host/docs.ts` and `src/host/tools/docs.ts` (the tools, and their one-line results), and `src/seed_docs/` (a soul, note-taking guidelines). `../slack_agent/agent/context.py` and its `notes.md` show a simpler version. Copy ideas, not files: flatbed's version should be a fraction of the size, with no owners, permissions, records or files.

## Guidance

- **A store, then a plugin.** `@flatbed/docs` in `ts/packages/docs` has a `DocStore` interface with a file implementation and an in-memory one. A document has a path-like `name` (such as `soul`, `people/tomas-reyes` or `timeline/2026-10-06`), a Markdown `body`, a one-line `summary`, a `pinned` flag, a `version`, and when and by whom it was last written. Every write keeps the previous version, and the store can list a document's history. A store is scoped to one agent; the host gives each agent its own. Keep the interface small enough that the example app can implement it on Postgres in an afternoon.
- **Context.** When a session opens, the plugin's `context` hook adds, in order: a short section explaining how the agent's documents work and how to keep them, then each pinned document as a section in a stable order, the last of them marked `cache: true`, then the timeline last. Render a document as `<doc name="..." summary="...">body</doc>`. The timeline section holds today's timeline document in full and one summary line for each of the six days before it. Take `today` from the host or the clock once at session open, and put no other times in the context.
- **Tools.** Few, with descriptions that say when to use them and one-line results: list documents with their summaries, read one, write one whole, edit one by replacing an exact passage, pin and unpin (taking effect at the next session, which the result should say), and add a line to today's timeline. A failure is a result that says what to do differently, never a throw.
- **Seeding.** The plugin takes optional seed documents, written only when the store does not already have them, so a host can give a new agent a soul and guidelines. Write a short invented soul and note-taking guidelines as examples, in the second-person voice of `docs/ways-of-working/writing.md`, and use them in the tests.
- **When a session ends**, the plugin may add nothing; the agent's own notes are the memory. Do not summarise sessions automatically.
- **Tests** at the boundary: a session opened with pinned documents has the right sections in the right order, an edit made in one session is in the next session's context, and the timeline shows today in full and earlier days as lines. Use the core's faux provider and memory store.
- Write `ts/packages/docs/README.md`: the idea, the context layout and why it is ordered so, and how a host sets the plugin up.

## Done when

`scripts/check.sh ts` passes with the new package's tests included, and the README shows a reader how to give an agent documents.

## Time and setting

Work for at most 90 minutes. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Other agents are working in other worktrees at the same time; change `ts/packages/core` only when you must, and then say so in the write-up. Run long commands in the foreground one at a time.

## Write-up

New package `@flatbed/docs` in `ts/packages/docs`. A `DocStore` with four calls (`get`, `list`, `put`, `history`), a memory store and a file store (one JSONL file per document, one version per line). `docsPlugin({ store, seeds, today })` adds the guide, the pinned documents sorted by name with `cache: true` on the last, then the timeline. It has six tools: `list_docs`, `read_doc`, `write_doc`, `edit_doc`, `pin_doc` and `add_to_timeline`. It also includes an invented soul and note-taking guidelines in `seeds/` (`exampleSeeds()`), the README, and a line in the overview's *Where we are*. I did not change the core.

Choices someone could make differently:

- The session's day comes from the session header's `createdAt`, so a session resumed by a later process keeps its day. `add_to_timeline` writes to that day too, not to the clock's day.
- Pin and unpin are one tool, `pin_doc` with `pinned: true|false`.
- Names are lower case, with no segment starting with a dot. The file store checks this as well.
- The plugin runs its own writes one at a time, because calls in one turn run at once. The store assumes one writer per agent.
- `write_doc` refuses `timeline/` names, and the first line of a day becomes its summary until the agent gives one.

Command: `scripts/check.sh ts` printed `== all checks passed`. The new suite ran 5 tests, all passing: section order, an edit reaching the next session, the timeline, seeds and the file store.

Left out on purpose: deleting documents, search, size caps on the context, and a decisions entry.

**How it went**: no problems. The brief and the spec were enough, and the Otherworldly files were good to read. I wanted an `exactOptionalPropertyTypes` note: supervisor sets it and the root tsconfig does not, so packages differ.

## Question for the lead

Should the timeline write to the day the session opened (my guess, built) or to the clock's day at each call? They differ only for a session that runs past midnight.
