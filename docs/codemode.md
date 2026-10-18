# Codemode

Codemode lets the model write a short Python script that calls several tools, loops over their results and returns only what it needs, in one turn instead of many. This page is the design, settled after a spike on 18 October 2026. Sam agreed the design on 18 October, with the worker process as the boundary.

## What it has to guarantee

Sam's conditions: a script must not be able to see how tools are implemented, reach the host's files, environment or network, or learn guardrails the agent should not know. Web access, where an agent has any, goes only through a tool the agent is allowed.

## How it works

A `codemode` plugin adds one tool, `run_script`. Its description lists the tools a script may call, as Python function signatures generated from their schemas.

The script runs in [Monty](https://github.com/pydantic/monty), Pydantic's sandboxed Python interpreter written in Rust, inside a separate worker process. The worker is one small Python program using `pydantic-monty`, shared by all three flatbed implementations: each host only starts the process and speaks to it in JSON lines over stdin and stdout. The conformance suite can then test codemode the same way in every language.

When a script calls a tool, Monty pauses, and the worker writes the call to stdout as `{call id, name, input}`. The host runs it through the loop's own tool runner, so `beforeTool`, the supervisor, the tool, `afterTool` and `maxConcurrentTools` apply exactly as for a direct call, and an unknown name gets the runner's usual `No tool named <name>.` The host writes the result back to stdin and the script resumes. Calls a script starts together with `asyncio.gather` run together on the host. The script's printed output and return value are the tool's result, and each nested call is recorded in the session.

Because the host sits outside the process, it enforces the limits from outside: it counts the calls coming out and ends the process at the agent's limit (25 unless set), ends it at a wall-clock deadline, and caps its memory. A stop ends the process too. A fresh process, or a fresh Monty session in a warm one, runs each script. The script sees the real clock; a host running replay tests can give the worker a fixed start time instead.

## Why a script cannot see behind the tools

The spike tried every usual escape in all three bindings and got the same answers:

- **No host code inside.** A tool is a stub, `<function 'read_doc' external>`, with no `__code__` or `__globals__`. `inspect`, `traceback`, `__import__`, `globals` and `dir` do not exist, and `().__class__` raises, so the object graph that Python's own `exec` would expose is out of reach.
- **No host resources.** Monty's `os` is its own: files and directories raise `PermissionError`, and the environment is not supported. There is no `socket`, `subprocess` or `urllib`, so the network exists only as a tool.
- **Only messages come back.** When a tool fails, the script sees its error type and message, never a host traceback.

## What tool authors own

A tool's error message reaches the script as written. Keeping host details, such as file paths, out of error messages is the tool author's job, as it is for direct calls.

## What still shows, by design

The tools' names, descriptions and schemas, which the model needs anyway; their results; and a supervisor's refusal text. Where guardrails should stay hidden, the guard can refuse with a generic message.

## Costs and risks

A warm run with one tool call takes about 0.15 ms in Python and TypeScript and much less in Rust; the packages are 38 MB (Python) and 63 MB (TypeScript). Monty is young, at version 1.2, and runs a subset of Python. Its Rust crate on crates.io lags the git tag, which the worker process sidesteps, since only Python runs Monty. QuickJS is smaller and more mature, but would mean a different engine and bridge in each language. The probes are in `spikes/codemode/`.

## Decisions for Sam

- Should tools that send or change something be callable from a script at all, or only read-only tools by default, with an agent opting others in? Until Sam decides, an agent lists the tools its scripts may call.
