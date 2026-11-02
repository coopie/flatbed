# Brief: opening calls, and startup.json in the docs plugin

Parker, the agent Sam talks to on Telegram (github.com/coopie/parker), is moving from pinned documents and a read-only `rules/` folder to a `startup.json` document that decides what each session opens with. It is a pattern Sam has used in his contracting work. Two parts of flatbed need to change for it, and both are general enough to belong here rather than in Parker. Read `AGENTS.md` and the docs it lists, then this brief. The decision as Parker records it is "startup.json decides what a session opens with", in Parker's `docs/decisions.md`; read it at `~/Documents/Programming/parker/docs/decisions.md`.

## The piece

**1. Opening calls, in the core.** A plugin's `context` hook may return tool calls as well as sections and tools. When a session opens, after the context entry and the start notice, the loop appends one assistant message holding every plugin's opening calls in plugin order, runs them as it runs any turn's calls, through `beforeTool` and `afterTool`, and appends their results. The model then sees, as its first exchange, calls it seems to have made and their real results. That is the point: what a read returns arrives as material in the conversation, not as instructions in the system prompt. Decide how the spec marks that assistant message as the harness's own, with no model call behind it, and how its usage counts towards the budget. Change the spec, all three cores and the conformance suite together, with scenarios for the behaviour a reader would notice.

The risk is the provider. On 20 October a change to how requests were built passed every scenario and broke every Opus call that followed. Before you build the three cores, check with one live call on `claude-opus-5-5` with thinking on that Anthropic accepts a conversation whose first assistant turn is tool calls with no thinking block, followed by their results and an event. If it does not, find the nearest shape that works, such as results delivered in a user message as material, and say what you chose in your write-up.

**2. startup.json, in the docs plugin.** A host may give the docs plugin a `startup` option holding the fixed entries, kept in code. The `startup.json` document is a list of entries, each a tool call with `system` and `fixed` flags:

- `system` entries come first, and each reads one document. Together they become sections, in order, and the last carries the cache mark. Once the `system` entries end, no later entry may be `system`.
- Every other entry becomes an opening call.
- A write to `startup.json`, through `write_doc` or `edit_doc`, is checked as a whole as it lands, in the spirit of "edit a document, then commit" in Parker's `docs/ways-of-working/agent-tools.md`. It is refused with every problem at once if it does not parse, breaks the `system` order, names a tool the agent does not have, or drops, changes or reorders a fixed entry from the host's list.
- A document read by a fixed entry is read-only to the agent, with a refusal that says why.
- With `startup` given, the plugin offers no `pin_doc`, and pinning plays no part. Without it, the plugin behaves as it does today, so the example app keeps working.

The guide text, the folders section and the timeline stay where they are. Update the plugin's README so a host can set it up from that alone.

## Done when

`scripts/check.sh` passes, the new scenarios pass in all three cores, the docs plugin's tests cover the commit check and fixed entries, and one live run on `claude-opus-5-5` with thinking on goes through a session that opens with a read as an opening call and then answers a message. Add a decision entry and bring `docs/overview.md` up to date.

## Time and setting

Work for at most 150 minutes, and write up what you have when you reach it, at the bottom of this brief. If the three cores do not all fit, finish TypeScript and the docs plugin first, since Parker needs those, and say what is left. Questions go to the lead, in a `## Question for the lead` section here, carrying on with your best guess. Work on the branch `opening-calls` in the worktree `~/Documents/Programming/flatbed-wt/opening-calls`, commit as you go, and leave merging to the lead. For live runs, symlink `.env` from `~/Documents/Programming/flatbed/.env` into the worktree; never print or log a value from it. Never use em dashes in anything you write.

## Write-up

**What changed.** A plugin's `context` hook may now return `calls`, each `{name, input}`. When a run opens a session, the loop appends one assistant message right after the start notice. It holds every plugin's calls in plugin order, with the ids `opening-1`, `opening-2` and so on. The loop runs those calls as it runs a turn's: by `toolExecution`, through the schema check, `beforeTool` and `afterTool`. Then it appends the results and delivers waiting events. The spec ([loop.md](../spec/loop.md), "Opening calls", with the run steps renumbered 1 to 7), all three cores and the suite changed together. Scenario 47 shows the calls, a `beforeTool` refusal among them, and the messages the model receives. Scenario 48 shows that a session that opens with calls and nothing else ends `idle` without a model call, and that a reset an opening call requests is ignored. In the docs plugin, a `startup` option holds the host's fixed entries. With it, `startup.json` decides what a session opens with, and `pin_doc`, pinned sections and "(pinned)" in listings go away. Without it, nothing changes, so the example app is untouched. `startup.ts` holds the commit check. The README has a setup section.

**Choices someone could make differently.**
- The opening message is marked as the harness's own by `model: "harness"`, with zero usage and `stop: "toolUse"`, rather than by a new field. It adds nothing to the budget; the first model call's `input` counts the results.
- The opening message and its results are looked past by needs-run, so opening calls never wake the model. Without that, every new session would pay for a call with nothing to answer, against the 7 October decision.
- A reset requested by an opening call is ignored rather than ending the session, which could loop forever.
- Fixed entries are checked as an ordered subsequence of the entries marked `fixed`, flags included, so dropping, changing, reordering and adding a fixed entry all fail. A document is read-only when a fixed `read_doc` reads it. Other tools that read documents, such as one of Parker's own, are not covered.
- When `startup.json` fails the check as a session opens, for example after the host changed its fixed entries, the session opens with the fixed entries alone. A `startup-problems` section before the timeline says what to fix. Tool names are not checked at that point, since the tools are not collected yet. If a call names a missing tool, it gets the core's `No tool named` result.
- When the store has no `startup.json`, the plugin seeds it with the fixed entries.

**How I know it works.** Before building, a one-off live probe on `claude-opus-5-5`, which always thinks, sent a first assistant turn of a `tool_use` with no thinking block, its `tool_result` and an event. Anthropic accepted it, and accepted a tool turn after it, so no fallback shape was needed. `ts/packages/docs/live.test.ts` (`FLATBED_LIVE=1`) then ran a full session through the loop. The session opened with a system read of `soul` and an opening read of `notes`, and the model answered "marmalade" from the notes in a response with a signed thinking block. On a second message it called `read_doc`, and its answer took cache reads of 1884, then 1957 tokens. `scripts/check.sh` passes in full, and the new scenarios pass in all three cores. The `assistant` section passes only without the `.env` symlink. With it, the section fails on all five Postgres tests ("tenant/user ... not found"), because the shared `.env` holds a `DATABASE_URL` for the Supabase project that is gone. The `ts` section passed with the symlink, and the rest passed after I removed it. `startup.test.ts` covers the sections and calls, the commit check with every problem at once, fixed reads, a `startup.json` that has gone stale, and a bad `startup` option.

**What is left.** Parker has to adopt it: pass `startup`, move `rules/` into fixed entries, and drop pinning.

**Suggestions.** `docs/stack.md` could say that the example app's tests read `DATABASE_URL` from `.env`, so a builder who links `.env` for a live run should run `scripts/check.sh assistant` without it until the Supabase project is back. The walkthrough, a snapshot from 6 October, does not mention opening calls.

**How it went.** The probe first meant the provider risk was settled in a few minutes, before any core changed. TypeScript first, as the reference, made handing Python and Rust to two parallel agents with the commit hash a quick, clean job. The spec had no word for an assistant message no model wrote, and "When a session needs a run" needed one more exception. Both are now in loop.md.
