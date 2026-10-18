# Codemode

Codemode lets the model write a short Python script that calls several tools, loops over their results and returns only what it needs, in one turn instead of many. This page is the design, settled after a spike on 18 October 2026. Nothing is built yet; Sam decides whether to build it.

## What it has to guarantee

Sam's conditions: a script must not be able to see how tools are implemented, reach the host's files, environment or network, or learn guardrails the agent should not know. Web access, where an agent has any, goes only through a tool the agent is allowed.

## How it works

A `codemode` plugin adds one tool, `run_script`. Its description lists the tools a script may call, as Python function signatures generated from their schemas. The script runs in [Monty](https://github.com/pydantic/monty), Pydantic's sandboxed Python interpreter written in Rust, which has Python, TypeScript and Rust bindings, so all three flatbed implementations share one codemode and the conformance suite can test it.

When a script calls a tool, Monty pauses and hands the host the name and arguments as data. The host runs the call through the loop's own tool runner, so `beforeTool`, the supervisor, the tool, `afterTool` and `maxConcurrentTools` all apply exactly as for a direct call, then resumes the script with the result. Calls a script starts together with `asyncio.gather` run together on the host. The script's printed output and return value are the tool's result, and each nested call is recorded in the session.

## Why a script cannot see behind the tools

The spike tried every usual escape in all three bindings and got the same answers:

- **No host code inside.** A tool is a stub, `<function 'read_doc' external>`, with no `__code__` or `__globals__`. `inspect`, `traceback`, `__import__`, `globals` and `dir` do not exist, and `().__class__` raises, so the object graph that Python's own `exec` would expose is out of reach.
- **No host resources.** Monty's `os` is its own: files and directories raise `PermissionError`, and the environment is not supported. There is no `socket`, `subprocess` or `urllib`, so the network exists only as a tool.
- **Only messages come back.** When a tool fails, the script sees its error type and message, never a host traceback.

## What the plugin must add

The spike found gaps the plugin closes itself:

- **Check every call's name** against the agent's codemode allow-list before running it. Through Monty's process pool, even an unknown name such as `__import__` arrives at the host as an ordinary call.
- **Count calls in the host.** The in-process Rust binding does not enforce Monty's call limit.
- **Clean error messages.** A tool's error message passes through as written, so strip host paths from it.
- **Limits:** a time limit on the script (which pauses while a tool runs), a deadline on each tool and on the whole run, and memory, recursion, output and call limits. Start a fresh interpreter session for every script, since a session that hit a limit cannot be trusted.
- **A fixed clock**, so scripts cannot time the host.
- **A stop** ends a script between calls. The TypeScript binding cannot cancel a script mid-run, so the deadline is the backstop there.

## What still shows, by design

The tools' names, descriptions and schemas, which the model needs anyway; their results; and a supervisor's refusal text. Where guardrails should stay hidden, the guard can refuse with a generic message.

## Costs and risks

A warm run with one tool call takes about 0.15 ms in Python and TypeScript and much less in Rust; the packages are 38 MB (Python) and 63 MB (TypeScript). Monty is young, at version 1.2, and runs a subset of Python. Its Rust crate on crates.io lags the git tag, and the Rust host has to write the loop that answers each pause, about 60 lines. QuickJS is smaller and more mature, but would mean a different engine and bridge in each language. The probes are in `spikes/codemode/`.

## Decisions for Sam

- Build it, starting with TypeScript and Python and adding Rust once its crate catches up?
- Should tools that send or change something be callable from a script at all, or only read-only tools by default, with an agent opting others in?
