# Kickoff: codemode fixes from its review

A read-only review of codemode and `ctx.runTool` on 18 October found the sandbox's allow-list, environment and process group sound, and `runTool` free of deadlocks, but eight problems in the three codemode plugins and gaps in `docs/codemode.md`. You are fixing them in all three languages. Read `AGENTS.md`, `docs/codemode.md`, `docs/spec/plugins.md`, the worker (`codemode/worker.py`), the three plugins (`ts/packages/codemode`, `python/flatbed/plugins/codemode.py`, `rust/codemode`), and then this brief. When you are done, add your write-up at the bottom of this file.

## What the review found

1. **Output can get past the memory cap.** `json.dumps` in the worker runs outside Monty's `max_memory`, so `[s]*200` of a 1 MB string became a 200 MB `call` line in under a second, and the same works for a `done` value. TypeScript's readline and Rust's `lines()` then buffer a line of any length; Python already caps lines at 16 MB.
2. **Calls already sent outlive a stopped script** in TypeScript and Python, including calls with side effects, and they outlive the turn's limiter. TypeScript also handles lines readline buffered after the script finished. Rust aborts them.
3. **The TypeScript host crashes on EPIPE** when the worker exits before reading `start`: `child.stdin` has no `'error'` listener.
4. **`NaN` and `Infinity`** make the worker write invalid JSON.
5. **A call can go unanswered** (Python on a `call` without `input`, Rust when a nested task panics), so the script waits for the deadline.
6. **stderr is read only after stdout closes** in Python and Rust, so a chatty worker blocks and a stray grandchild delays the end.
7. **The plugins record and report differently**: Rust's recorded call has no `type`, and Rust echoes a whole non-JSON line, of any size, into the model's result.
8. **Rust's `Place::take_back`** holds its lock while waiting for a place.

The review also found the doc not yet enough to write a fourth host from: the order of `params`, the size limits and what a host does with a malformed or unknown line, the exact error wording for each way a script ends, the recorded call's id and `custom` entry shape, what happens to calls in flight, and that a host drains stderr. It contradicts itself on warm processes, and says the conformance suite tests codemode when it does not yet.

## The rule for calls in flight

The lead chose one rule for all three, matching the core's own stop in `docs/spec/host.md`: once a script ends early, by its deadline, its call limit or a stop, no further call it made starts; calls already running see the stop on their `signal`; and `run_script` waits for them before it returns, so their results are recorded and the turn's limit holds. Write it into `docs/codemode.md`.

## Guidance

- One cap on every message, in the worker and in each host's reader, with a script that tries to exceed it getting an error at the call or in its result.
- Settle the recorded shape and the error wording in the doc first, then make the three plugins match it.
- Where the review named a smaller way to write something, take it.

## Done when

`scripts/check.sh ts python rust` passes, each plugin has a test for findings 1, 2 and 4, and someone could write a fourth host from `docs/codemode.md` alone.

## Time and setting

Work for at most 90 minutes; stop and write up what you have when you reach it. Sam is around today. If a choice would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. The Anthropic key in `.env` works; never print a value from it. Run long commands in the foreground one at a time, and wait for slow Rust builds.

## Write-up
