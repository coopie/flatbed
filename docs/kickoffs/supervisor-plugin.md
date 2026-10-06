# Kickoff: the supervisor as a plugin, and as an agent

You are taking `@flatbed/supervisor` from a library to something an agent uses. The library can already check a session against a spec in one model call. This piece adds the plugin that checks tool calls before they run, and a second way to supervise: a flatbed agent that investigates with tools before it gives its verdict. Read `AGENTS.md` and the docs it lists, `docs/spec/plugins.md`, `ts/packages/core`, `ts/packages/supervisor` and its README, and then this brief. When you are done, add your write-up at the bottom of this file.

## Guidance

- **Use the core's types.** Replace the provider and session types the library defined locally with `@flatbed/core`'s.
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
