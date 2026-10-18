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

Spike run on 18 October 2026 against Monty 1.2.0 (`pydantic-monty`, `@pydantic/monty`, and the `monty` crates at git tag `v1.2.0`), on an Apple Silicon Mac. The probes are in `spikes/codemode/`: `python/probe.py`, `typescript/probe.ts`, `rust/src/main.rs` (in-process), `rust/src/bin/pool.rs` (subprocess pool) and `quickjs/probe.ts` for comparison. All are rough.

### The bridge

All three bindings work the same way underneath. When a script calls a name it did not define, the interpreter stops and hands the host the function name and arguments. The host runs the tool and resumes the script with a value or an exception.

- **Python.** `external_lookup` or an `ExternalModule` (`import tools`) exposes tools, and `feed_run` answers every call for you. `feed_start` instead returns a snapshot at each call with `function_name` and `args`, which is where flatbed would run `beforeTool`, the tool and `afterTool`. With `AsyncMonty`, tools can be coroutines awaited on the host's event loop. Three 0.3-second tools under `asyncio.gather` finished in 0.30 seconds, so they ran concurrently.
- **TypeScript.** The API is the same, and every host function may be async. `gather` over three 0.3-second tools took 0.30 seconds. `feedStart` and `resume` or `resumeError` give the same step-by-step control.
- **Rust.** In-process, `MontyRun::start` returns `RunProgress` events (`NameLookup`, `FunctionCall`, `OsCall`, `ResolveFutures`, `Complete`) and the host writes the loop that answers them, about 60 lines. `resume_pending` lets the host start a tokio task per call, and `ResolveFutures` asks for results when the script awaits. `gather` took 0.30 seconds in-process and 0.31 seconds through `monty-pool`.

A script that calls an async tool without `await` gets a coroutine object back, so the tool's description should say to await.

### What a script can see

All three bindings run the same interpreter, so the escape probes gave the same answers:

- `import os` works, but it is Monty's own module. `os.listdir('/')`, `open('/etc/passwd')` and `Path(...).read_text()` raise `PermissionError`. `os.environ` and `os.getenv` raise `RuntimeError: ... is not supported in this environment`.
- `__import__`, `globals`, `dir` and `__builtins__` are not defined. `subprocess`, `socket`, `urllib`, `inspect` and `traceback` are not modules.
- `().__class__` raises `AttributeError`: there is no route to `__subclasses__`.
- A tool appears as `<function 'read_doc' external>`. It has no `__code__`, `__globals__`, `__closure__`, `__module__` or `__doc__`. In TypeScript the repr shows the JavaScript function's own name (`readDoc`), not the name the script used.
- `eval` and `exec` exist, but they compile inside the sandbox under the same limits.
- When a host tool raises, only the exception type and message cross. No host traceback, file path or source line came through, unless the message itself contained one: my probe put a file path in the message and the script could read it. A plain JavaScript `TypeError` crossed with its message. A JavaScript object passed in as an input lost its methods and arrived as `{}`.
- The script can read the wall clock (`time.time()`) and `sys.version` (`3.14.0 (Monty)`). A session policy can fix the clock.

The in-process Rust interpreter never touches the operating system. Every such request reaches the host as an `OsCall` (`Iterdir`, `GetEnviron`, `Getenv`, `Open`, `Import`) for the host to refuse. Two cautions for a Rust host:

- A call to an undefined name can arrive as a `FunctionCall` with no `NameLookup` first. Through `monty-pool`, `__import__('os')` reached my host as a call named `__import__`, and my careless host answered it. The host must check every call's name against the agent's tools.
- In-process, `max_suspensions` is not enforced: a script made 50 calls under a limit of 10. The pool and the Python and TypeScript bindings enforce it.

### Limits

| Limit | Setting | What the script got |
| --- | --- | --- |
| Time | `max_feed_duration_secs` 0.5 | `TimeoutError: feed time limit exceeded: 500.09ms > 500ms` after 0.50 s; uncatchable |
| Memory | `max_memory` 10 MB | `MemoryError: memory limit exceeded`; `[0] * 100_000_000` was refused before allocating |
| Recursion | `max_recursion_depth` 100 | `RecursionError`, catchable, as in CPython |
| Output | print collector capped at 10 kB | `MemoryError: memory limit exceeded: 16384 bytes > 10000 bytes`, the same text as a heap limit |
| Host calls | `max_suspensions` 10 | `RuntimeError: suspension limit 10 exceeded`; uncatchable |

The time limit counts only interpreter time and pauses while a tool runs, so the host needs its own deadline on tools, plus `request_timeout` as a backstop. After a time or memory limit, the session's heap cannot be trusted: codemode should use a fresh checkout per script. Python can cancel a run through asyncio; the TypeScript `feedRun` takes no abort signal, which matters for flatbed's stop. I did not test stopping a TypeScript run mid-feed.

### Cost

| Binding | Install size | Pool start | First run | Warm run with one tool call |
| --- | --- | --- | --- | --- |
| Python | 38 MB (28 MB worker binary, 9.5 MB package) | 0.9 ms | 6 ms | 0.14 ms |
| TypeScript | 63 MB (35 MB native, 24 MB WebAssembly worker) | 0.5 ms | 6 ms | 0.16 ms |
| Rust, in-process | 11.6 MB release binary, 44 s build | none | none | 0.005 ms |
| Rust, `monty-pool` | as above, plus a worker binary | 1.7 ms | not measured | 0.05 ms |
| QuickJS (comparison) | 9.1 MB | 4 ms | none | 0.14 ms |

### The weakest binding

Rust is the weakest:

- crates.io has only 1.1.0, which does not compile on rustc 1.98.1. I pinned the `v1.2.0` git tag.
- There is no ready-made driver. The host writes the suspension loop, checks call names and, in-process, enforces the suspension limit.
- In-process there is no crash isolation. The pool gives isolation but needs a separate worker binary; I borrowed the one from the Python package.

Once driven, it behaved exactly like the other two.

In TypeScript, my first run stalled once the pool ran out of workers: checkouts released with `await using` inside a `for...of` body did not come back. They came back when disposed explicitly, and I could not reproduce the stall on its own. A `checkoutTimeout` turns it into an error rather than a hang.

### Recommendation

Build flatbed's codemode on Monty. What decides it:

- **One interpreter in all three implementations.** The escape probes, limit messages and suspension protocol came out the same in Python, TypeScript and Rust. One codemode spec and one set of conformance cases can cover all three. QuickJS would mean a different engine and bridge in each language.
- **The bridge matches flatbed's tool runner.** Each call stops with a name and arguments, so the host can send it through `beforeTool`, the tool and `afterTool` and log it. `gather` gives concurrency the host can cap with `maxConcurrentTools`.
- **Two walls in Python and TypeScript.** The language sandbox has no file, environment or network operations at all, and scripts run in a worker subprocess started with an empty environment. QuickJS in WebAssembly runs inside the host process.

QuickJS is smaller (9 MB) and older. It also showed no host access in the probes, but in 20 lines I hit a runtime abort and a use-after-free from manual handle lifetimes, and async tools need the host to pump jobs.

The risks of Monty are its youth (version 1.x, a Python subset, a bounty programme for escapes) and the gaps above. For the plugin:

- use a fresh checkout per script
- set the time, memory, suspension and output limits, `request_timeout`, and a deadline on each tool
- fix the clock
- allow-list call names
- check that tool error messages carry no host details
