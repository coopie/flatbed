# Kickoff: ctx.runTool in the three cores, and codemode on it

Codemode's builder found that a tool had no way to run another call through the core's own tool runner, so each codemode plugin copies about 30 lines of the runner, wraps the other plugins' `context` hooks to find their tools, and runs a script's calls under a limit of its own, so a turn can run up to twice `maxConcurrentTools` calls at once. The lead has added `ctx.runTool(call)` to the spec (`git show HEAD~1 -- docs/spec/plugins.md`, section "A tool that runs other tools"). You are building it in all three cores and moving the three codemode plugins onto it. Read `AGENTS.md`, `docs/spec/`, `docs/codemode.md`, the three cores, the three codemode plugins (`ts/packages/codemode`, `python/flatbed/plugins/codemode.py`, `rust/codemode`), and then this brief. When you are done, add your write-up at the bottom of this file.

## Guidance

- **The core.** `runTool` on a tool's `ctx` in each language, running a call through the same path as the loop's, under the turn's limiter, giving up the calling tool's place while it waits. The limiter is the delicate part: with `maxConcurrentTools` of 1 or serial execution, a tool calling `runTool` must still make progress.
- **Scenarios**, extending `docs/spec/conformance.md` as little as you can: a tool whose behaviour runs other calls with `runTool` and returns what they gave, showing the nested calls pass through `beforeTool` and `afterTool`; the same with `toolExecution: serial`, showing it completes; and `maxRunning` showing nested and direct calls together never exceed the limit.
- **Codemode.** Each plugin drops its copied runner and the `withCodemode` wrapping where `runTool` makes them unnecessary. If the wrapping is still the plainest way for a host to say which tools a script may call, keep that part and say why.
- Keep the three loops readable; the numbered step comments that match `loop.md` stay.

## Done when

`scripts/check.sh ts python rust` passes, every scenario passes in all three cores, the codemode tests still pass, and `docs/codemode.md` and the codemode README say how it works now.

## Time and setting

Work for at most 90 minutes; stop and write up what you have when you reach it. Sam is around today. If a choice would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. The Anthropic key in `.env` works; never print a value from it. Run long commands in the foreground one at a time, and wait for slow Rust builds.

## Write-up
