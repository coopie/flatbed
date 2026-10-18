# Codemode

Codemode lets the model write a short Python script that calls several tools, loops over their results and returns only what it needs, in one turn instead of many. This page is the design, settled after a spike on 18 October 2026. Sam agreed the design on 18 October, with the worker process as the boundary.

## What it has to guarantee

Sam's conditions: a script must not be able to see how tools are implemented, reach the host's files, environment or network, or learn guardrails the agent should not know. Web access, where an agent has any, goes only through a tool the agent is allowed.

## How it works

A `codemode` plugin adds one tool, `run_script`. Its description lists the tools a script may call, as Python function signatures generated from their schemas. A host adds codemode with `withCodemode`, which wraps the other plugins' `context` hooks so that codemode can see the tools they add, since a `context` hook sees nothing of other plugins' tools and codemode needs the allowed tools' descriptions and schemas.

The script runs in [Monty](https://github.com/pydantic/monty), Pydantic's sandboxed Python interpreter written in Rust, inside a separate worker process. The worker is one small Python program using `pydantic-monty`, shared by all three flatbed implementations: each host only starts the process and speaks to it in JSON lines over stdin and stdout. The three can then be tested the same way, though the conformance suite does not test codemode yet; each implementation has its own tests.

When a script calls a tool, Monty pauses, and the worker writes the call to stdout as `{call id, name, input}`. The host runs it with the core's `ctx.runTool`, as [plugins.md](spec/plugins.md) describes, so it runs exactly as a direct call: the schema check, `beforeTool`, the supervisor, the tool and `afterTool` apply. Nested calls share the turn's limit of `maxConcurrentTools` with the model's own calls, and `run_script` gives up its place while it waits for them, so a turn never runs more calls at once than its agent allows, and a script still makes progress when the limit is 1 or calls are serial. A tool off the allow-list does not exist inside the script, so calling it raises `NameError`; the host also answers any call it is sent for such a name with the runner's usual `No tool named <name>.` The host writes the result back to stdin and the script resumes. Calls a script starts together with `asyncio.gather` run together on the host. The script's printed output and return value are the tool's result, and each nested call is recorded in the session, as [What the host does](#what-the-host-does) describes.

Because the host sits outside the process, it enforces the limits from outside: it counts the calls coming out and ends the process at the agent's limit (25 unless set), ends it at a wall-clock deadline, and caps its memory. A stop ends the process too. A fresh process runs each script. The script sees the real clock; a host running replay tests can give the worker a fixed start time instead.

## The protocol

The worker is `codemode/worker.py` at the repo root, a Python project of its own with one dependency, `pydantic-monty`. A host starts it for one script with `uv run --quiet --frozen --project codemode python codemode/worker.py`, in its own process group and with an environment holding only `PATH` and `HOME`. The two then exchange JSON objects, one per line: the host writes to the worker's stdin and reads its stdout. Anything the worker writes to stderr is for a person debugging it.

Every message, in either direction, is at most 1,048,576 bytes (1 MiB) of UTF-8, not counting its newline. The cap keeps a script from using the messages to get past its memory limit: the worker builds each message outside Monty, so a script could otherwise turn a list of a thousand references to one long string into a line a thousand times longer. Both sides check it before they send, and the reader checks it again.

### From the host

**`start`**, once, first. `tools` are the functions the script may call. Each has its parameter names in `params`, so that positional arguments can be named: the required parameters first, then the optional ones, each in the order of the tool schema's `properties`, which is also the order of the Python signature in `run_script`'s description. `timeoutMs`, `maxMemory` (bytes, 64 MB unless given) and `startTime` (ISO 8601, which fixes the script's clock) are optional.

```json
{"type": "start", "script": "import asyncio\nawait asyncio.gather(read_doc('a'), read_doc('b'))", "tools": [{"name": "read_doc", "params": ["name"]}], "timeoutMs": 60000, "startTime": "2026-10-18T09:00:00+00:00"}
```

**`result`**, once for each `call`, in any order. `text` is the tool result's text blocks joined. When `isError` is true, the script sees `RuntimeError` with `text` as its message; otherwise the call returns `text` as a string.

```json
{"type": "result", "id": "1", "text": "contents of a", "isError": false}
```

### From the worker

**`call`**, whenever the script calls a tool. Each has its own `id`, a string, and several may be waiting at once when the script gathers calls. The worker maps positional arguments to the names in `start`, so `input` is always an object.

```json
{"type": "call", "id": "1", "name": "read_doc", "input": {"name": "a"}}
```

**`done`**, last, when the script finishes. `output` is what it printed, up to 100,000 bytes, and `value` the value of its last line: a string as it is, anything else as JSON or, failing that, its `repr`, and `null` when there is none. `NaN` and `Infinity` are not JSON, so a value holding them comes back as its `repr`.

```json
{"type": "done", "output": "found it\n", "value": "[\"contents of a\", \"contents of b\"]"}
```

**`error`**, last, when the script fails, with what it printed before failing and Monty's traceback, which shows only the script's own lines.

```json
{"type": "error", "output": "", "error": "Traceback (most recent call last):\n  File \"<python-input-0>\", line 1, in <module>\n    1 / 0\nZeroDivisionError: division by zero"}
```

The worker keeps its messages valid JSON and within the cap, and turns what it cannot send into an error the script or the model sees:

- A call whose input is not JSON, such as one holding `NaN`, raises `ValueError` at the call in the script, and nothing is sent.
- A call whose message would pass the cap raises `ValueError` at the call, and nothing is sent.
- A `done` whose message would pass the cap becomes an `error` saying the value is larger than the limit for a message.

### What the host does

A host answers every `call` with exactly one `result`, as long as the script is running. It enforces the script's limits from outside:

- It counts `call` messages and ends the process when one more would pass its limit, 25 unless set.
- It ends the process at its own wall-clock deadline, which counts time spent in tools. Monty's own time limit, which the worker sets from `timeoutMs`, counts only time running the script, so it is only a backstop.
- It ends the process when the run's stop is set.
- It ends the process once it has read `done` or `error`.
- It checks every `call` name against the allow-list itself, rather than trusting the worker, and answers a name off it with the runner's usual `No tool named <name>.`
- When a tool's result would make a `result` message pass the cap, it answers with an error result instead, so the script sees `RuntimeError`.
- It reads stderr while the script runs, keeping only the last 2,000 characters, so that a worker that writes a lot there cannot block on a full pipe.

To end the process, the host closes stdin and kills the process group. The worker also stops on its own when stdin closes, which ends Monty's interpreter process even when the host could not kill the group. When stdout closes without `done` or `error`, the host kills the group before it reads the rest of stderr, so that a stray process still holding stderr open does not delay the end, and waits at most a second for it.

A host treats a worker that breaks the protocol as failed: it ends the process, and the script's result is an error. A line that is not JSON, a line longer than the cap, and a `call` without a string `id`, a string `name` and an object `input` all break it. A message of any other `type` is ignored.

#### Calls in flight

Once a script ends early, by its deadline, its call limit or a stop, the host starts none of the calls it made that it has not yet started. A call has started once the host has passed it to `runTool`. Calls already started run to their end, and see the run's stop on their `signal` as any running call does. The host ends the worker at once, but `run_script` waits for these calls before it returns, so that their results are recorded and the turn's limit on calls at once still holds. This matches what a stop does to a turn's own calls, in [host.md](spec/host.md). It means a slow tool can hold `run_script` past its deadline, as it would hold a direct call.

The host reads nothing more from the worker once the script has ended, so a `call` the worker sent before it was killed is not started.

#### What the model sees

The tool result the model sees is `output` without its last newline, then `value` or `error` on a line of its own. It is an error result when the script failed or did not finish. The wording for each way a script ends:

| How the script ended | The result's text |
| --- | --- |
| `done` | `output` and `value` joined, or `The script returned nothing.` when both are empty |
| `error` | `output` and `error` joined |
| The deadline passed | `The script ran for more than <seconds> seconds, so it was stopped.`, with the seconds as the shortest decimal, such as `1`, `1.5` or `60` |
| One call too many | `The script made more than <limit> tool calls, so it was stopped.` |
| The run was stopped | `The harness stopped this script.` |
| The worker could not be found | `The codemode worker could not start: <command> was not found.` |
| The worker could not start for another reason | `The codemode worker failed: <the error's message>` |
| stdout closed early | `The codemode worker ended without finishing the script.`, then the trimmed stderr tail on the next line when there is one |
| A line that is not JSON | `The codemode worker sent a line that is not JSON: <its first 200 characters>` |
| A line longer than the cap | `The codemode worker sent a line longer than 1048576 bytes.` |
| A malformed `call` | `The codemode worker sent a call it cannot make: <the line's first 200 characters>` |
| The `start` message would pass the cap | `The script is too long: a message to the worker may be at most 1048576 bytes.` |

A `result` the host could not send for the cap reads `The result of <name> is larger than the 1048576-byte limit for a message.`

#### What the session records

Each call the host starts is recorded as a `custom` entry from the `codemode` plugin, once its result is in, whether or not the script is still running to receive it. Its `data` is the call and its result:

```json
{"call": {"type": "toolCall", "id": "9f3a61c2-1", "name": "read_doc", "input": {"name": "a"}}, "result": {"content": [{"type": "text", "text": "contents of a"}], "isError": false}}
```

The call's `id` is the script's id, 8 hexadecimal characters fresh for each run of `run_script`, a hyphen, and the worker's id for the call, so ids stay unique across scripts in one session. It is also the id the hooks and the tool see. The result is the one the tool returned, after `afterTool`, even when the host sent the script an error in its place for the cap. A call off the allow-list is recorded too, with the `No tool named <name>.` result.

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
