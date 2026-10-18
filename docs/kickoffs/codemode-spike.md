# Kickoff: a codemode spike on Monty

Sam wants a codemode for flatbed: the model writes a short script that calls several tools, and only the script's output comes back. His condition is safety: the script must not be able to see how the tools are implemented, reach the host's files, environment or network, or learn the guardrails, and web access must go only through a tool the agent is allowed. `docs/codemode.md` has the design so far. The proposal now is to run scripts in Monty, Pydantic's sandboxed Python interpreter written in Rust (https://github.com/pydantic/monty), because it has Python, TypeScript and Rust bindings, so all three flatbed implementations could share one codemode and the suite could test it. This spike finds out whether Monty can carry that. Read `AGENTS.md`, `docs/codemode.md`, `docs/spec/plugins.md` and `docs/spec/host.md`, Monty's README and docs, and then this brief. When you are done, add your write-up at the bottom of this file.

## What to find out

For each binding, Python (`pydantic-monty`), TypeScript (`@pydantic/monty`) and Rust (`monty`):

- **The bridge.** How a host-provided function is called from a script: does the run pause at the call and resume with the host's value, can the host answer asynchronously, and can a script start several calls together (for example `asyncio.gather`) so the host can run them concurrently?
- **What a script can see.** Try to escape, and record what each attempt returns: `import os`, `open`, `__import__`, `().__class__.__base__.__subclasses__()`, `inspect.getsource` on a tool, a tool function's `__code__` or `__globals__`, `globals()`, a traceback from a host function that raises (does it show host file paths or source lines?).
- **Limits.** Time, memory, recursion and output size, and how each is reported.
- **Cost.** Start-up time per run and the binding's install size.

Keep the probes in `spikes/codemode/`, one small script per language, rough and marked as such at the top.

## What to bring back

A short report in the write-up: the answers above, which binding is weakest and why, and a recommendation on whether flatbed's codemode should be built on Monty, or on QuickJS for JavaScript scripts, with what you saw that decides it. Do not build the plugin yet.

## Time and setting

Work for at most 75 minutes; stop and write up what you have when you reach it. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Install packages only inside `spikes/codemode/`. Never print a value from `.env`; the spike needs no model calls. Run long commands in the foreground one at a time.

## Write-up
