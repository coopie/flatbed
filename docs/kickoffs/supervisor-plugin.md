# Kickoff: the supervisor as a plugin, and as an agent

You are taking `@flatbed/supervisor` from a library to something an agent uses. The library can already check a session against a spec in one model call. This piece adds the plugin that checks tool calls before they run, and a second way to supervise: a flatbed agent that investigates with tools before it gives its verdict. Read `AGENTS.md` and the docs it lists, `docs/spec/plugins.md`, `ts/packages/core`, `ts/packages/supervisor` and its README, and then this brief. When you are done, add your write-up at the bottom of this file.

## Guidance

- **Use the core.** Replace the types, `pathOf`, the escaping and the live test's stand-in provider that the library defined locally with `@flatbed/core`'s, so events render exactly as the core renders them.
- **Fix what the wave 1 review found:** `prompt.ts` throws on a reset with no reason; add `blocked(spec, verdict)`, true for an `unavailable` verdict or any failed `block` item, and use it everywhere a host might use `failures()`; a host's answer must not silently replace the model's answer to a model item; and a verdict records the `callId` it judged, when there was one.
- **The guard plugin.** The host gives it a map from tool name to spec, a mode and a `complete` function. Its `beforeTool` hook checks each call to a mapped tool against the session so far.
  - `off`: nothing is checked.
  - `shadow`: the verdict is recorded and the call runs.
  - `enforce`: a failed `block` item replaces the call with a result that tells the agent which items failed and why, so it can redraft. `warn` items never block.
  - Every verdict, including `unavailable`, is appended as a `custom` entry with `plugin: "supervisor"`, so a host can show it beside the call. When the model fails, `enforce` lets the call through or refuses it according to a setting, refusing by default.
- **An agent as supervisor.** A second runner gives the check to a flatbed agent, with the spec as its context and the session as its first event, plus any tools the host passes, such as reading the agent's documents. It finishes by calling a `report_verdict` tool whose input schema is the derived verdict schema, and its own session is stored like any other, with a header that links to the session it checked. Both runners return the same verdict shape, so the guard takes either.
- **Tests** with the faux provider: shadow records and lets the call run, enforce refuses on a failed block item and lets a warn item through, an unavailable verdict follows the setting, and the agent runner returns a verdict from a `report_verdict` call.
- Update the README: when to use one call and when an agent, and how to set up the guard.

## Done when

`scripts/check.sh ts` passes with the new tests, and the README shows a host how to guard a tool.

## Time and setting

Work for at most 60 minutes. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Other agents are working in other worktrees at the same time; change `ts/packages/core` only when you must, and then say so. Run long commands in the foreground one at a time.

## Write-up

**What changed.** `@flatbed/supervisor` now builds on `@flatbed/core`: its local types are gone, and it uses the core's `pathOf`, `renderEvent` (so events read exactly as the agent saw them), the core's escaping rules, and its providers in the tests. The review fixes are in: a reset with no reason renders, `blocked(spec, verdict)` is the one way to decide, a host answer to a model item throws, and verdicts carry `callId`. New: `supervisorGuard` (guard.ts) with `off`, `shadow` and `enforce`, and `agentPass` (agent.ts), which ends on `report_verdict`.

**Choices.** The guard takes a `Supervise` rather than a `complete`, so it takes either runner. `agentPass` writes its session's header, context and material itself and then runs the loop, because the core escapes event text and the material is already XML. The parent link uses `reason: "dispatch"`. Checks on one runner are queued. A refusal is an error result listing every failed item as `<failed_check>` with analysis and guidance. Custom entry data is `{ mode, refused, verdict }`. See `docs/decisions.md`. I removed the package's own tsconfig: its `exactOptionalPropertyTypes` fails on the core, and the workspace config is the gate.

**Commands.** `scripts/check.sh ts`: core 6 pass 1 skipped, docs 5 pass, supervisor 14 pass 1 skipped (live), "all checks passed". The live test was not run, since the key is revoked.

**Left out.** No turn limit on the agent supervisor beyond the core's context budget. Nothing in `ts/packages/core` changed. `docs/overview.md` still lists the supervisor under *Now*.

**How it went.** Two core gaps slowed me: the core does not export its escaping, so the supervisor copies two lines of it, and there is no way to start a session with a user message or a chosen header, so the agent runner writes to the store directly. A core `openSession({ parent, messages })` or an exported `escapeText` would remove both. Header `parent` also cannot name another agent's session.
