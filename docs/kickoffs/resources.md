# Brief: resources, structured state an agent reads and patches

Agents built on flatbed keep two kinds of thing. Documents are prose the agent thinks with, such as notes on people, and the docs plugin serves them well. The other kind is structured state the system acts on: Parker's schedule (`cron.json`), what a session opens with (`startup.json`), and the briefs that guard its tools. Today each is a JSON document with its own hand-written check on every write, so the agent reads JSON wrapped in a `<doc>` tag and escaped, edits it with find-and-replace, and each new kind of state means another bespoke check. Sam and the lead have settled on a shared shape for them, called resources. Read `AGENTS.md` and the docs it lists, then this brief. Parker (`~/Documents/Programming/parker`, branch `next`) is the first user; its `src/agent/cron.ts` and `src/agent/briefs.ts` show the two bespoke checks this replaces, and `docs/ways-of-working/agent-tools.md` there describes the "edit, then commit" pattern this is a version of.

## The design

A new package, `@flatbed/resources`, is a small library and one plugin. The core does not change.

- **A resource** is defined in code with a name, a short guide for the agent, a JSON Schema, an initial value, an optional `check(next, previous, ctx)` that returns problems and may be async (so a supervisor can be the check), named `views` (functions from the value to what a read shows, with a default), and an optional `onChange` for the host. Schema fields marked `readOnly: true`, the standard JSON Schema keyword, belong to the host.
- **The store** is as small as `DocStore`: `get(name)` gives the value and its version, and `put(name, value, expectedVersion)` saves a new version or refuses a stale one. Every version is kept. Give it a memory store and a file store, as the docs plugin has.
- **The plugin** gives the agent two tools and a short context section listing each resource with its guide:
  - `read_resource(name, view?)` returns the view as plain JSON, with the version.
  - `edit_resource(name, version, patch)` applies a JSON Patch (RFC 6902) to a copy, then validates it against the schema, refuses any change to a `readOnly` field, and runs `check`. Either the store saves the new version, or the agent gets every problem at once and nothing changes. An edit based on an older version is refused with a reason that says to read again. There is no draft and no separate commit, so the agent never has to wonder whether what it sees is saved.
- **The host** writes through the same library with its own permission, such as setting a `readOnly` field when a cron entry fires, and hears about every change through `onChange`.
- **Collections keyed by id**, such as `{"ola-card": {...}}`, keep patch paths stable, so the guide and the examples should lead with them. An ordered list is fine where order matters.

**startup moves here.** The startup resource, which the docs plugin holds today as `startup.json` (see `ts/packages/docs/startup.ts`), becomes a resource whose definition also contributes a plugin: its `context` reads its own value and returns the system sections and the opening calls, as now, with the host's fixed entries kept by its `check`. Keep everything the current version does, including refusing `reset` as an entry and the fallback when a stored value no longer fits the fixed entries. Take startup out of the docs plugin, so that it goes back to documents, folders and the timeline; it still needs a way to leave pinning out when a host opens sessions from startup, and the `read_doc` description should stop mentioning pinning in that case. Update `examples/playground/recordings` if a tool's bytes change, as the review of the opening-calls piece noted.

JSON Schema validation needs a validator. A small, well-known one is fine; check it runs in a Cloudflare Worker, since Parker runs there, which rules out validators that compile schemas with `new Function`.

## Done when

`scripts/check.sh` passes. The package has a README a host can set it up from alone, tests at its boundary (a patch that passes, one that fails the schema, one that touches a `readOnly` field, one that fails `check` with several problems, a stale version, a view), and startup's existing tests pass in their new home. One live run on `claude-opus-5-5` with thinking on goes through an agent reading a resource, patching it, getting a refusal, and patching it again correctly; say in the write-up how well the model handled JSON Patch, since that is the main risk in the design. Add a decision entry and bring `docs/overview.md` up to date.

## Time and setting

Work for at most 150 minutes, and write up what you have at the bottom of this brief. Questions go to the lead, in a `## Question for the lead` section here, carrying on with your best guess. Work on the branch `resources` in the worktree `~/Documents/Programming/flatbed-wt/resources`, commit as you go, and leave merging to the lead. For live runs, symlink `.env` from `~/Documents/Programming/flatbed/.env` and remove the link when you finish; with it in place, `scripts/check.sh` fails at `assistant` on Postgres tests, as `docs/stack.md` says, so run the other sections by name. Never print or log a value from `.env`. Never use em dashes in anything you write.

## Write-up

**What changed.** A new package, `ts/packages/resources`, with a [README](../../ts/packages/resources/README.md) a host can set up from. `createResources(store, definitions)` is the library: `read`, `edit` (a JSON Patch against a version), `write` (a whole value) and `problems`. Every change is applied to a copy, then the schema, the `readOnly` fields (skipped for `host: true`) and `check` are applied, and it is saved as the next version or refused with every problem. The store refuses a stale `put` itself, so the host and the agent cannot overwrite each other. `memoryResourceStore` and `fileResourceStore` (in `/node`) keep every version. `resourcesPlugin` adds the `resources` section and `read_resource` and `edit_resource`, and runs each resource's own hooks. Startup is now `startupResource({ fixed, docs, folders? })`, with everything it did before: the fixed entries kept by its check, `reset` refused, the fallback and `startup-problems` section, read-only fixed reads and missing or sealed reads. The docs plugin lost `startup` and gained `pinning: false`, which also drops pinning from `read_doc`'s description. The decision entry and the overview are updated.

**Choices someone could make differently.**
- JSON Patch is written in the package (171 lines) rather than taken from `fast-json-patch`, so a failed path says what is there instead, such as an object's members.
- The validator is `@cfworker/json-schema`, which has no `eval` or `new Function`. The tests pass under `node --disallow-code-generation-from-strings`. I did not run it inside `workerd`.
- Startup stays an ordered list, since order matters. Its problems now name entries by path (`The entry at /1`), to match patch paths.
- `@flatbed/resources` depends on `@flatbed/docs`, but only for startup: it renders system reads with `renderDoc`, and refuses writes to fixed reads through `writeTarget` in its own `beforeTool`. That keeps the docs plugin free of startup.
- Section order is now resources, the system reads, then the docs guide and the timeline. Before, the docs guide came first.
- `readOnly` fields are compared only where the object holding them survives, so removing a whole entry is allowed. In lists they are compared by position.

**How I know it works.** `scripts/check.sh` passed with `.env` unlinked ("all checks passed"). Resources has 11 tests: six at the boundary (the six cases the brief lists) and the five startup tests, ported. Docs has 12. The playground check and build passed. Its recording is unchanged, because it pins, so the tool bytes are the same.

The live run on `claude-opus-5-5` with thinking passed in 11 s. In one parallel turn Opus read both resources and the doc list. In the next it sent two patches. One went to `startup`: `add /-` with a notes read, saved. The other went to `schedule`: two `replace` operations and an `add` with a new key. That one was refused as stale, because the test's host fired the entry in between. Opus read the schedule again, saw `lastRun`, and resent the same patch against version 2, which was saved, with `lastRun` kept. Its paths, ops and values were correct throughout. A probe I did not keep asked it to "replace" an entry that had `lastRun`. It wrote `remove` then `add` under new ids, which is allowed. JSON Patch looks like a low risk for Opus. I have not tried smaller models.

**What is left.** Parker still has to move `cron.json`, `briefs/` and its `startup.json` document over; the README says how to copy startup across. Python and Rust have no resources, since this is a TS plugin.

**How it went.** The brief was clear, and Parker's `cron.ts` and `agent-tools.md` made the shape obvious. What took longest was turning `@cfworker/json-schema`'s nested errors into one line per problem. In `assistant` and `playground`, `scripts/check.sh` prints "× installing dependencies" from pnpm's `verifyDepsBeforeRun`, but passes. It does this on the base branch too, and is worth a look.

## Review

The piece does what the brief asks, and reads well. The library is small and the refusals are written for the agent: a failed path names what is there instead, schema errors come once each at the deepest place, and a stale edit says to read again. Startup moved over whole, with its fallback, `reset` refusal and read-only fixed reads, and the docs plugin is simpler for losing it. The README is enough to set a host up from. `scripts/check.sh ts` and `scripts/check.sh playground` pass after my changes, with `.env` unlinked. I did not repeat the live run.

**What I changed,** in one commit:
- `applyPatch` refused nothing when a path ended in `__proto__`: the assignment set the copy's prototype, so the member never reached the value, yet the edit reported "Saved". `add` (and so `replace`, `move` and `copy`) now refuses a member named `__proto__`.
- A `from` that was not a string failed with "Pointer.startsWith is not a function". The well-formedness check now says `from` must be a JSON Pointer.
- `memoryResourceStore` handed out its own stored objects from `get` and `history`, so a host that changed what it read changed the history. It now returns copies, as the file store does.
- The decision said the patch code was about 150 lines; it is about 170.

**What I flagged,** for the lead:
- **Plugin order now matters twice.** The resources plugin must come before docs so the system reads sit before the timeline, and the refusal of writes to fixed reads moved from inside the docs tools to startup's `beforeTool`. A plugin listed earlier whose `beforeTool` answers a `write_doc` first, such as a guard that holds a call for a person and runs it later, would skip that refusal. The README says to list resources first; it does not say why for the second reason.
- **Two section cache marks.** Startup marks its last system read and docs marks its guide, which uses both section breakpoints the Anthropic provider has left after the tools and history. Fine today, but a third plugin's mark would be dropped silently.
- **`readOnly` is followed through `properties`, `patternProperties`, `additionalProperties`, `prefixItems` and `items` only.** A schema that puts a host field under `allOf`, `anyOf`, `oneOf` or `$ref` leaves it unprotected with no warning. Parker's schedule and briefs will not need those, but `createResources` could refuse a `readOnly` it cannot reach.
- **`@flatbed/resources` depends on `@flatbed/docs`** only for startup. Parker's schedule will pull in docs with it. A subpath export for startup would cut that if a host ever wants resources alone.
- **Worker compatibility is inferred,** from tests passing under `--disallow-code-generation-from-strings`, not run in `workerd`. That is a fair proxy, but Parker's first deploy is the real test.
- Copying an entry that has a host field into a new key is refused with "this edit sets it. Leave it as it is.", which is right but reads oddly for a copy. Minor.

**Where the docs did not give me enough to judge:**
- Whether a TS-only plugin with its own on-disk format needs a spec. The docs plugin set the precedent of none, and `ways-of-working` speaks of the spec only for the core, so I took it as fine.
- How many cache marks a plugin may use, and how plugins should agree on order. Nothing in the spec or `stack.md` says, and this piece is the first where two plugins' sections must interleave in a set order.
- How to check that code runs in a Cloudflare Worker. The brief asks for it, and `stack.md` does not say how; a `wrangler dev` or `workerd` smoke test there would let the next piece check rather than infer.
