# Codemode

Codemode lets the model write a short Python script that calls several tools, loops over their results and returns only what it needs, in one turn instead of many. This page is the design, settled after a spike on 18 October 2026. Sam agreed the design on 18 October, with the worker process as the boundary.

## What it has to guarantee

Sam's conditions: a script must not be able to see how tools are implemented, reach the host's files, environment or network, or learn guardrails the agent should not know. Web access, where an agent has any, goes only through a tool the agent is allowed.

## How it works

A `codemode` plugin adds one tool, `run_script`. Its description lists the tools a script may call, as Python function signatures generated from their schemas. A host adds codemode with `withCodemode`, which wraps the other plugins' `context` hooks so that codemode can see the tools they add, since a `context` hook sees nothing of other plugins' tools and codemode needs the allowed tools' descriptions and schemas.

The script runs in [Monty](https://github.com/pydantic/monty), Pydantic's sandboxed Python interpreter written in Rust, inside a separate worker process. The worker is one small Python program using `pydantic-monty`, shared by all three flatbed implementations: each host only starts the process and speaks to it in JSON lines over stdin and stdout. The conformance suite can then test codemode the same way in every language.

When a script calls a tool, Monty pauses, and the worker writes the call to stdout as `{call id, name, input}`. The host runs it with the core's `ctx.runTool`, as [plugins.md](spec/plugins.md) describes, so it runs exactly as a direct call: the schema check, `beforeTool`, the supervisor, the tool and `afterTool` apply. Nested calls share the turn's limit of `maxConcurrentTools` with the model's own calls, and `run_script` gives up its place while it waits for them, so a turn never runs more calls at once than its agent allows, and a script still makes progress when the limit is 1 or calls are serial. A tool off the allow-list does not exist inside the script, so calling it raises `NameError`; the host also answers any call it is sent for such a name with the runner's usual `No tool named <name>.` The host writes the result back to stdin and the script resumes. Calls a script starts together with `asyncio.gather` run together on the host. The script's printed output and return value are the tool's result, and each nested call is recorded in the session.

Because the host sits outside the process, it enforces the limits from outside: it counts the calls coming out and ends the process at the agent's limit (25 unless set), ends it at a wall-clock deadline, and caps its memory. A stop ends the process too. A fresh process, or a fresh Monty session in a warm one, runs each script. The script sees the real clock; a host running replay tests can give the worker a fixed start time instead.

## The protocol

The worker is `codemode/worker.py` at the repo root, a Python project of its own with one dependency, `pydantic-monty`. A host starts it for one script with `uv run --quiet --frozen --project codemode python codemode/worker.py`, in its own process group and with an environment holding only `PATH` and `HOME`. The two then exchange JSON objects, one per line: the host writes to the worker's stdin and reads its stdout. Anything the worker writes to stderr is for a person debugging it.

### From the host

**`start`**, once, first. `tools` are the functions the script may call, each with its parameter names in order, so that positional arguments can be named. `timeoutMs`, `maxMemory` (bytes, 64 MB unless given) and `startTime` (ISO 8601, which fixes the script's clock) are optional.

```json
{"type": "start", "script": "import asyncio\nawait asyncio.gather(read_doc('a'), read_doc('b'))", "tools": [{"name": "read_doc", "params": ["name"]}], "timeoutMs": 60000, "startTime": "2026-10-18T09:00:00+00:00"}
```

**`result`**, once for each `call`, in any order. `text` is the tool result's text blocks joined. When `isError` is true, the script sees `RuntimeError` with `text` as its message; otherwise the call returns `text` as a string.

```json
{"type": "result", "id": "1", "text": "contents of a", "isError": false}
```

### From the worker

**`call`**, whenever the script calls a tool. Each has its own `id`, and several may be waiting at once when the script gathers calls. The worker maps positional arguments to the names in `start`, so `input` is always an object.

```json
{"type": "call", "id": "1", "name": "read_doc", "input": {"name": "a"}}
```

**`done`**, last, when the script finishes. `output` is what it printed, and `value` the value of its last line: a string as it is, anything else as JSON or, failing that, its `repr`, and `null` when there is none.

```json
{"type": "done", "output": "found it\n", "value": "[\"contents of a\", \"contents of b\"]"}
```

**`error`**, last, when the script fails, with what it printed before failing and Monty's traceback, which shows only the script's own lines.

```json
{"type": "error", "output": "", "error": "Traceback (most recent call last):\n  File \"<python-input-0>\", line 1, in <module>\n    1 / 0\nZeroDivisionError: division by zero"}
```

### What the host does

- It counts `call` messages and ends the process when one more would pass its limit, 25 unless set.
- It ends the process at its own wall-clock deadline, which counts time spent in tools. Monty's own time limit, which the worker sets from `timeoutMs`, counts only time running the script, so it is only a backstop.
- It ends the process when the run's stop is set.
- It ends the process once it has read `done` or `error`.
- It checks every `call` name against the allow-list itself, rather than trusting the worker.

To end the process, the host closes stdin and kills the process group. The worker also stops on its own when stdin closes, which ends Monty's interpreter process even when the host could not kill the group.

The tool result the model sees is `output` without its last newline, then `value` or `error` on a line of its own. Each nested call is recorded in the session as a `custom` entry from the `codemode` plugin, with the call and its result.

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

Each script starts a fresh worker process, which takes 80 to 120 ms on an Apple Silicon Mac: about 20 ms for `uv run`, 50 ms to import `pydantic-monty` and 20 ms to start Monty's interpreter and run a small script. That is small beside a model turn, so there is no warm process. Inside a warm one, a run with one tool call takes about 0.15 ms; the packages are 38 MB (Python) and 63 MB (TypeScript). Monty is young, at version 1.2, and runs a subset of Python. Its Rust crate on crates.io lags the git tag, which the worker process sidesteps, since only Python runs Monty. QuickJS is smaller and more mature, but would mean a different engine and bridge in each language. The probes are in `spikes/codemode/`.

## Decisions for Sam

- Should tools that send or change something be callable from a script at all, or only read-only tools by default, with an agent opting others in? Until Sam decides, an agent lists the tools its scripts may call.
