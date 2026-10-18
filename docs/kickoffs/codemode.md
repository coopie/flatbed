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
