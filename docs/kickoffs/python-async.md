# Kickoff: async Python, and a limit on concurrent tool calls

You are moving the Python core to `asyncio`, so that it reads like idiomatic modern Python and runs a turn's tool calls together, as the TypeScript core does. Sam's direction: async Python throughout, wherever it fits, with tool calls run through `asyncio.gather` under a semaphore that caps how many run at once. Read `AGENTS.md`, `docs/spec/loop.md` (the limit is new: `maxConcurrentTools`, 4 by default), `python/flatbed`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Guidance

- **Async throughout.** The loop, providers, plugin hooks and tools are coroutines. A run is `await agent.run()`. Tool calls in a turn run with `asyncio.gather` under an `asyncio.Semaphore(max_concurrent_tools)`, and their results are appended in call order. The stop signal is an `asyncio.Event`, so a stop also ends a backoff wait and can cancel an in-flight model call.
- **HTTP.** The standard library has no async HTTP client. Use `httpx` with an `AsyncClient`, which saves writing one; it is the only new dependency. Keep the Anthropic adapter's translation as it is.
- **Stores** may stay synchronous file I/O where that is simpler and fast, wrapped with `asyncio.to_thread` only if a store could block for long. Say what you chose.
- **Plugins and tools** written as plain functions are still accepted where it costs one line to do so, by awaiting the result when it is awaitable. Say whether you did this.
- **TypeScript** gains the same limit: `maxConcurrentTools` on the agent config, with a small semaphore around the tool runner in `ts/packages/core/loop.ts` and a unit test that no more than the limit run at once. Rust stays one at a time, which the spec allows.
- Add `maxConcurrentTools` to the conformance format only if a scenario needs it; the order of results is already tested.
- The conformance runner, the CLI and the tests become async too. The live check must pass: the key in `.env` works now. Run it once.

## Done when

`scripts/check.sh` passes in full, all 27 scenarios pass in Python, the Python live check passes, and the code reads as plain modern async Python.

## Time and setting

Work for at most 75 minutes. When you reach it, stop and write up what you have.

Sam is around today; if a choice would change the shape of the work, add a `## Question for the lead` section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Never print a value from `.env`. Run long commands in the foreground one at a time.

## Write-up

**What changed.** The Python core is `asyncio` throughout: `await runner.run()`, async providers, hooks, tools, conformance runner, CLI and tests. A turn's calls run with `asyncio.gather`, each under `asyncio.Semaphore(max_concurrent_tools)`, results appended in call order. `StopSignal` wraps an `asyncio.Event`; `stop.unless_set(...)` cancels a model call in flight, which also ends a backoff wait. The Anthropic provider uses `httpx.AsyncClient`; translation is unchanged. TypeScript gains `maxConcurrentTools` (default 4), a 15-line limiter in `loop.ts`, and a unit test. Python has the same test plus one for a stop cancelling a model call. Decisions, overview and the stack line are updated.

**Choices.** Plain functions are still accepted: one `settled()` helper awaits whatever is awaitable. Stores stay synchronous: one line appended to a local file is fast. The provider opens a client per call, so no client outlives its event loop; pooling would save a TLS handshake per turn. `StopSignal.set` must run on the loop's thread. `PluginContext.append` is now a coroutine. No conformance change: no scenario needed the limit.

**Commands.** `scripts/check.sh ts`, `python`, `rust`: all passed, 27/27 scenarios each; Python 14 tests, 1 skipped. `FLATBED_LIVE=1 uv run python -m unittest tests.test_live`: OK in 5.4s. The full `scripts/check.sh` failed in `assistant`: the Postgres tests read `DATABASE_URL` from `.env`, got `EADDRNOTAVAIL`, and one hung for 25 minutes. That is outside this change; the app's `pnpm run check` passes with 0 errors.

**Left out.** Rust stays one at a time. `walkthrough.html` still says Python is synchronous on urllib; it is a snapshot.

**How it went.** Smooth; the code was easy to convert. The assistant tests cost 25 minutes: they should time out quickly when the database is unreachable, and `check.sh` could say which section failed.
