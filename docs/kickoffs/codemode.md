# Kickoff: codemode, on one Monty worker process

Codemode lets the model write a short Python script that calls several tools and returns only what it needs, in one turn. Sam agreed the design on 18 October: `docs/codemode.md`. The heart of it is a worker process that runs scripts in Monty and talks to the host in JSON lines over stdin and stdout, so the host enforces limits from outside and all three flatbed implementations share the same worker. A spike on 18 October showed the pieces work; its probes and write-up are in `spikes/codemode/` and at the bottom of `docs/kickoffs/codemode-spike.md`. Read `AGENTS.md`, `docs/codemode.md`, `docs/spec/plugins.md` and `docs/spec/host.md`, the spike, and then this brief. When you are done, add your write-up at the bottom of this file.

## What to build

- **The worker**, one small Python program using `pydantic-monty`, in its own folder with its own `pyproject.toml`, run with `uv run`. It reads a script and the callable tools' signatures, runs the script, writes each tool call out and reads each result back, and writes the script's output at the end. It takes an optional fixed start time, for replay tests.
- **The protocol**, written into `docs/codemode.md` as a short section: the messages each way, with an example of each. Keep it small enough that a fourth language could speak it from the page alone.
- **The plugin in all three languages**: `ts/packages/codemode`, and the smallest fitting home in `python/` and `rust/` (Python and Rust have had no plugins until now, so say where you put them and why). Each adds `run_script` for an agent's allow-list of tools, starts the worker, runs each call through the loop's own tool runner so the hooks and `maxConcurrentTools` apply, records the nested calls, and ends the process at the call limit (25 unless set), at a wall-clock deadline, on a memory cap, and when the run's stop is set.
- **Tests** in each language with the fake provider: a script that gathers two tool calls that overlap, a call to a tool not on the allow-list, the call limit, the deadline, a stop during a script, and a script error. Skip them with a clear message when `uv` is missing.
- A README for the TypeScript package that teaches the idea, and a line in each of the other two pointing to it.

The spike found that a session which hit a limit cannot be trusted, so each script gets a fresh Monty session. Starting a fresh process per script is the simple default; a warm process is worth it only if start-up shows up as slow, so measure it and say what you found.

## Done when

`scripts/check.sh ts python rust` passes with the new tests, and the protocol section in `docs/codemode.md` is enough to write a host from.

## Time and setting

Work for at most two and a half hours; stop and write up what you have when you reach it. Sam is around today. If a choice would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Another builder is changing the three cores at the same time, so leave `ts/packages/core`, `python/flatbed`'s core modules and `rust/flatbed` alone, and say in the write-up if the plugin needed anything from them. The Anthropic key in `.env` works; never print a value from it. Run long commands in the foreground one at a time.

## Write-up

Built on 18 October 2026 on the `codemode` branch, with `main` merged in after the align-fixes landed. `scripts/check.sh ts python rust` passes, with six codemode tests in each language and a live test in TypeScript that passed once against `claude-sonnet-5-5`.

### What is where

- **The worker**: `codemode/worker.py` at the repo root, with its own `pyproject.toml` and `uv.lock` (`pydantic-monty==1.2.0`). It runs one script in a fresh `AsyncMonty` session, names positional arguments from the signatures in `start`, writes each call out, and finishes with `done` or `error`. When stdin closes it cancels the run, which ends Monty's interpreter process.
- **The protocol**: a new section in `docs/codemode.md`, with the four messages and an example of each, and what the host does.
- **TypeScript**: `ts/packages/codemode`, with a README that teaches the idea.
- **Python**: `python/flatbed/plugins/codemode.py`. A new `flatbed.plugins` subpackage is the smallest home that ships with the package and imports like the core; it touches no core module.
- **Rust**: a new workspace crate, `rust/codemode` (`flatbed-codemode`), so that the core crate stays untouched and `tokio`'s `process` feature and `libc` stay out of it.

The Python and Rust module docs point to the TypeScript README.

### How it behaves

- `withCodemode(plugins, { tools: [...] })` (`with_codemode` in Python and Rust) returns your plugins followed by `codemode`, which adds `run_script`. Its description lists the allowed tools as `async def` signatures.
- Nested calls go through the agent's `beforeTool`, the tool and `afterTool`, with the frozen schema check and the usual error words. Each is recorded as a `custom` entry with the call and its result.
- A tool off the allow-list does not exist in the script, so it raises `NameError`. The host also refuses such a name itself.
- The process is ended at the call limit (25), at the deadline (60 seconds, tool time included), on a stop and when the script finishes. Memory is capped by Monty's `max_memory` (64 MB) inside the worker; the host has no outside cap.
- The worker starts in its own process group with only `PATH` and `HOME`, and the host kills the whole group. The first test run showed why: killing only `uv` left Monty's interpreter spinning for minutes after a `while True` script.

### Start-up

A fresh process per script takes 80 to 120 ms: about 20 ms for `uv run`, 50 ms to import `pydantic-monty` and 20 ms to start Monty and run a small script. That is small beside a model turn, so I did not build a warm process.

### What the plugin needed from the cores

Nothing was changed in them. But the core gives a tool no way to run a call through the loop's own runner, so each plugin repeats the runner's steps (about 30 lines) and wraps the other plugins' `context` hooks to find their tools' code. It reads the hooks from `ctx.agent.plugins` and the schemas from the session's `context` entry. Nested calls get their own limiter of `maxConcurrentTools`, separate from the turn's, so a turn can run up to twice that many calls at once.

### Things to know

- A script that calls a tool without `await` gets a coroutine object, but the call still runs on the host. The description says to await.
- The TypeScript live test imports `readEnv` from `../core/env.ts`, since the core does not export it.

## Question for the lead

Should the cores give tools a way to run a nested call, such as `ctx.runTool(call)`, through the same runner and limiter? That would remove the `withCodemode` wrapping and the copied runner in all three languages, and let nested calls share the turn's `maxConcurrentTools`. My best guess is yes, as a small change for the cores' builder after this merges. I carried on with the wrapping meanwhile.
