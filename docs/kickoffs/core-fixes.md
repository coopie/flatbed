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
