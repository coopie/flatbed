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

`ctx.runTool` is in all three cores, the three codemode plugins use it, and `scripts/check.sh ts python rust` passes. Every scenario passes in all three cores, including three new ones. The codemode tests pass, and the TypeScript live codemode test passed once against the real model.

### The core

Each core now gives a turn's calls one limiter with separate "take a place" and "give it back" steps. A call takes a place, then runs steps 1 to 5 with a context whose `runTool` runs another call the same way. While a tool has calls of its own running, it holds no place. It takes one back when the last of them finishes. A nested call shares its caller's `requestReset`. Once the stop is set, a nested call that has not started gets `The harness stopped before this tool ran.`, as a direct call does.

- TypeScript: `toolContext` and `runLimited` in `run` in `loop.ts`
- Python: a small `Place` class and `_run_calls` in `loop.py`
- Rust: `Turn` and `Place` in `agent.rs`, and `Ctx::run_tool` in `plugin.rs`

The numbered step comments are unchanged.

Two things changed beyond the brief:

- **Serial execution.** It used to be a limiter of size 1. A tool that gave up its place would have let the next direct call start early, so serial now starts each direct call after the one before has finished, and still has one place.
- **A tool that ends while its calls still run.** Codemode does this when it stops a script at its call limit. Without care, the tool's place is released twice, and later one is taken and never given back. With a limit of 1, that hangs the turn. Each core now tracks whether the tool holds a place, and has a test for this case (`loop.test.ts`, `test_loop.py`, `rust/flatbed/tests/run_tool.rs`).

### Scenarios

There is one new behaviour, `runTools`, documented in `conformance.md`. While the tool waits for its calls, the runner does not count it as running.

- **44.** The nested calls meet `afterTool`, `beforeTool`, an unknown name and a missing property.
- **45.** With `toolExecution: serial`, the turn completes with `maxRunning` 1.
- **46.** `maxConcurrentTools` is 2, and nested and direct calls run together with `maxRunning` 2.

### Codemode

Each plugin drops its copied runner, its own limiter and its frozen-schema lookup, and calls `ctx.runTool`. It still checks the allow-list itself.

The `withCodemode` wrapping stays, but now records only the tools' definitions. Codemode needs the allowed tools' descriptions and schemas to write `run_script`'s description. A `context` hook sees nothing of other plugins' tools, so wrapping is still the plainest way to get them. Each language has a new test: with `maxConcurrentTools` 1, a script's gathered calls run one after the other and the script finishes. `docs/codemode.md` and the README describe the new behaviour.

### Not done

`docs/walkthrough.html` embeds an older copy of the TypeScript loop. I left it alone.

## Question for the lead

1. `plugins.md` says nothing about three choices I made: a nested call shares its caller's `requestReset`; after a stop, a nested call that has not started gets the not-run error; and a tool that ends while its calls run takes no place back. Should the spec say so in a sentence? My guess is yes, after the "A tool that runs other tools" paragraphs.
2. Should the wrapping go too? It could, if the core passed the tools gathered so far to later `context` hooks, for example as `ctx.tools`. That would be a small spec change. My guess is that it is worth doing only if a second plugin needs it.
