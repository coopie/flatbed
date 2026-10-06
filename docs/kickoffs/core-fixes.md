# Kickoff: fixes to the core from the wave 1 review

You are fixing what the review of the TypeScript core found, in the spec, the core and the conformance suite together. Python and Rust implementations are being written from the spec right now, so the spec must end up exact. Read `AGENTS.md`, the whole of `docs/spec/`, `ts/packages/core`, and then this brief. When you are done, add your write-up at the bottom of this file.

## The findings to fix

Each is a change to the spec, the TypeScript core and, where it says, a new conformance scenario.

1. **When a session needs a run.** It needs a run when the last entry on its path, ignoring `custom` and `context` entries, is a `tool` message or an event that is not from the harness (`attrs.from` other than `harness`). The one exception is the soft-budget notice: after appending it, the loop runs one more turn. So a stop notice, a failed-call notice and a session-started notice wait for the next real event. Update the stop scenario so the next run needs a delivered message, and add one showing a `custom` entry after a tool result does not end the run.
2. **Events never land between a call and its result.** `ctx.append` takes only `custom` entries; events always go through `deliver`. A rewind target must not be an assistant message that has tool calls. In the Anthropic adapter, put `tool_result` blocks first in a merged user message.
3. **Rewinds stay inside the open session.** Delivery roots an event whose `parentId` is not in the open session at the head instead, and the spec says so.
4. **Cache breakpoints.** Anthropic allows at most four. Cap the section breakpoints so the total, with the tools and the history, stays within four, and cache the conversation history too, so long sessions do not pay for the whole history each turn. Check how against Anthropic's current prompt caching docs rather than from memory. Write the rule in `docs/spec/providers.md`.
5. **Stop reasons.** Add `refusal` to the stops. Any other unknown reason maps to `end`. Say so in the spec.
6. **Empty text blocks** are dropped by the Anthropic adapter, in the system prompt, in messages and in tool results, since the API rejects them. A tool result left with no blocks gets the text `(no output)`.
7. **A turn cut off by `maxTokens`** runs none of its tool calls; each gets an error result, `The response was cut off before this call was complete.` Let an agent's config pass `effort` through to providers that take it, as `output_config.effort` for Anthropic, and say in the spec that it is optional.
8. A missing thinking signature is left out, not stored as the string `undefined`.
9. **Small gaps:**
   - the soft-limit notice is appended when the session has no such notice yet, found from the log, not from memory
   - a reset with an empty reason is stored without `reason`
   - the backoff sleep ends when the stop signal is set
10. **Conformance scenarios** for each plugin hook (`beforeTool` replacing a call, `afterTool` changing a result, `onEntry` appending a `custom` entry, `onSessionEnd` delivering an event to the next session), a stop during a model call, repair partway through a turn's results, a reset with no reason, and an event with several attributes and characters to escape. Extend the scenario format in `docs/spec/conformance.md` with the smallest test plugin that can express these.
11. **Small tidy-ups:** build the frozen context once per run rather than once per turn, and remove the redundant spread the review named at `loop.ts:83`.

Leave `ts/packages/supervisor` alone; another piece fixes it.

## Done when

`scripts/check.sh ts` passes with every new scenario, and the spec says exactly what the code does. List every spec change in the write-up, briefly, because the Python and Rust builders will be sent that list.

## Time and setting

Work for at most 75 minutes. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. The API key in `.env` is revoked; do not look for another, and never print a value from `.env`. Run long commands in the foreground one at a time.

## Write-up

All eleven findings are fixed in the spec, the TypeScript core and the conformance suite. `scripts/check.sh ts` passes, with 24 scenarios (10 new, 1 changed) and 4 new adapter tests. Nothing was tried against the real Anthropic API, since the key is revoked.

### Spec changes, for the Python and Rust builders

`loop.md`:

- A session needs a run when the last entry on its path, ignoring `custom` and `context` entries, is a `tool` message or an event whose `attrs.from` is not `harness`. The one exception: after appending the soft-limit notice, the loop runs one more turn. A run that finds nothing to answer ends `idle` without calling the model or checking the stop signal.
- A new step 4 freezes the context, and the tools it names, once per run. The later steps are renumbered.
- The provider call passes the agent's `effort` when it is set.
- When an assistant message stops with `maxTokens`, none of its calls run and plugins are not called. Each call gets an `isError` result: `The response was cut off before this call was complete.`
- The loop adds the soft-limit notice when the session's entries, read from the store, hold no such notice yet. It searches all the entries, not only the path.
- A reset with a missing or empty reason is stored without `reason`.

`sessions.md`:

- A rewind stays in the open session and never leaves a call unanswered. Delivery appends the event at the head instead when its parent is not in the open session, or when the path up to the parent lacks a result for a call of its last assistant message.
- `stop` gains `refusal`. A stop reason a provider does not know maps to `end`.
- A thinking block without a signature leaves `signature` out.
- Harness events do not on their own make a session need a run.

`plugins.md`:

- `ctx.append` takes only `custom` entries and fails for anything else. Events always go through `deliver`.
- An event delivered from `onSessionEnd` arrives after the next session's `Session started` notice.
- Calls in a turn cut off by `maxTokens` never reach the plugins.

`providers.md`:

- The request gains an optional `effort`. Providers that take it pass it through; the rest ignore it.
- Unlisted stop reasons map to `end`. An aborted signal also ends a backoff wait early.
- The Anthropic adapter section was rewritten:
  - In a merged user message, `tool_result` blocks come first.
  - Empty text blocks are dropped everywhere. An empty tool result becomes `(no output)`.
  - `effort` goes in `output_config.effort`.
  - `refusal` maps to `refusal`.
  - A request holds at most four cache breakpoints: the top-level `cache_control` for the history, one on the last tool when there are tools, and the rest on the earliest `cache: true` sections.
- OpenAI sends `effort` as `reasoning_effort` and maps `content_filter` to `refusal`.

`conformance.md`:

- `agent.maxTokens`.
- An optional `plugin` field gives the test plugin `beforeTool`, `afterTool`, `onEntry` and `onSessionEnd`.
- A script entry `{"abort": "<who>"}` sets the stop signal while the call is in flight, then fails the call.

### New or changed scenarios

- Changed: 10 (stop).
- New:
  - 15: `onEntry` adds a `custom` entry after a tool result, and the run continues.
  - 16: `beforeTool`.
  - 17: `afterTool`.
  - 18: `onSessionEnd` delivers to the next session.
  - 19: stop during a model call.
  - 20: repair partway through a turn's results.
  - 21: reset with no reason, then with an empty reason.
  - 22: escaping.
  - 23: `maxTokens` cut-off.
  - 24: a rewind to a call goes to the head.

### Questions for the lead

- I widened rewind validation from "not an assistant message with tool calls" to "leaves no call unanswered". This also rejects a target partway through a turn's results. A bad target falls back to the head, as finding 3 asks, rather than throwing. Throwing would happen mid-run, long after the host's `deliver` call.
- The history breakpoint uses Anthropic's automatic caching (top-level `cache_control`), which the docs recommend for multi-turn conversations and which takes one of the four slots. I chose this over a block-level mark on the last message. It is untested against the live API.
- For OpenAI, `effort` as `reasoning_effort` and `content_filter` as `refusal` go beyond the brief. Both are easy to drop.
