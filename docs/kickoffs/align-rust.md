# Kickoff: an async Rust core

The three cores drifted apart where the conformance suite could not see, so the spec changed on 18 October: one host API, async throughout, concurrent or serial tool calls by setting, and exact stop behaviour. The Rust core is the furthest away: it is blocking on `ureq`, runs tools one at a time, cannot interrupt a model call once sent, has sync-only hooks, holds `ctx.append` until a hook returns, and does not reject duplicate tool names. You are moving it to `tokio`. A TypeScript builder is writing the new scenarios at the same time; build to the spec, then merge `main` when the lead says the scenarios have landed, and make them pass. Read `AGENTS.md`, the whole of `docs/spec/` (`git show 3fedbe5` shows what changed, and `host.md` is new), `rust/flatbed`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Guidance

- **The shape that has worked in the other two:** an async loop; a turn's calls started in order under a semaphore of `max_concurrent_tools`, or one after another when serial; the model call raced against the stop, so the run can abandon it whatever the provider does; backoff waits that end on the stop. In Rust that suggests `tokio`, `reqwest`, a `tokio_util::sync::CancellationToken` behind `StopSignal`, `select!`, and `Arc` where `Rc` is today. Async hooks and tools as boxed futures or `async-trait` are both reasonable; choose the one that reads better and say why.
- `ctx.append` writes at once, as the spec now says.
- Add the OpenAI provider, and the shared provider options and retry rules.
- Teach the conformance runner the format additions in `docs/spec/conformance.md`.
- The Rust core is the largest of the three today. Where a rewrite makes something smaller or plainer, take it: a reader should be able to follow the loop in about a screen.

## Done when

`scripts/check.sh rust` passes, clippy included, with every scenario, including the new ones once they land, and the live check passes once.

## Time and setting

Work for at most two and a half hours; stop and write up what you have when you reach it. Sam is around today. If a choice would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main` (merging `main` into your branch is expected). The Anthropic key in `.env` works; never print a value from it. Touch only `rust/`, the `rust` section of `scripts/check.sh`, and the spec where it is unclear, saying so in the write-up. Builds can be slow; run them in the foreground one at a time.

## Write-up

The Rust core is now async on `tokio` and passes `scripts/check.sh rust` (fmt, clippy with `-D warnings`, tests, and all 37 scenarios, 28 to 37 included). The live check passed once against Anthropic. `main` is merged in twice, the second time with the TypeScript and Python alignments.

### What changed

- **Async throughout.** `Plugin`, `Tool`, `Store` and `Provider` are async traits, and `Agent::run` is an `async fn`. `reqwest` replaces `ureq`, and `tokio::fs` backs the file store. `Rc` and `RefCell` are now `Arc` and `Mutex`, so an agent and its plugins can move between tasks.
- **The host API matches `host.md`.** `Agent::new(config, store, providers)` returns a `Result`. It fails at once when the model's provider is missing or `max_concurrent_tools` is below 1. `deliver(event, parent_id)` takes `&self`, so a host can queue an event while a run is going; `deliver_after` is gone. `run(stop)` takes `&self` too, and an `AtomicBool` guard refuses a second run at once. `AgentConfig` gains `tool_execution` and `max_concurrent_tools`.
- **Stops.** `StopSignal` now lives in `stop.rs`: a `CancellationToken` plus who stopped the run. The loop races the model call against it with `select!`, so a call that hangs is abandoned. The shared HTTP helper races each try, and each backoff wait, against it. A tool sees it as `ctx.signal()` and can await `stopped()`.
- **Tool calls.** A turn's calls run under a fair `Semaphore` with `join_all`. The limit is `max_concurrent_tools`, or 1 when serial, so serial calls need no second code path. Once the stop is set, a call that has not started gets the repair text. After the turn's results, the `Stopped by` notice follows.
- **`ctx.append` writes at once.** `Ctx` holds the run's shared state (`Arc<Run>`): the session behind a `tokio` mutex, the queue and the reset request. An append holds the lock until the entry is written, then calls `on_entry`. `Run::append` is boxed, since `on_entry` may append again. The old `Outputs` buffer is gone.
- **Duplicate tool names**, including a plugin's `reset`, fail the run before anything is written: `Two tools are named <name>.`
- **Needs a run:** a `Stopped by` notice that follows the soft-limit notice keeps the session needing a run, as the updated `loop.md` says.
- **Providers.** There is a new `openai` provider, ported from the TypeScript one, with its tests. `ProviderOptions` (`api_key`, `base_url`, `timeout` of 600 seconds) is shared. `providers/http.rs` holds the retry rules: no response, 408, 409, 429 or 500 and above; waits of 1, 2 and 4 seconds. A new test checks that a stop ends the backoff at once.
- **The conformance runner** knows `effort`, `toolExecution`, `maxConcurrentTools`, `hang`, `sleep`, `waitForStop`, `stopAfter`, `{"error": ...}` outcomes, request objects with exact counts, `maxRunning`, and a 10-second limit for each scenario.

### Choices

- **`async-trait` over hand-boxed futures.** Plugin authors write plain `async fn`s with default bodies. Hand-written versions would put `Pin<Box<dyn Future + Send + '_>>` in every hook signature. The boxing costs one allocation per call, which does not matter here.
- **`FnTool` takes an async closure with owned input and a cloned `Ctx`**, so its future needs no borrowed lifetimes.
- **`tool_execution` is an enum**, so the new `host.md` rule (fail when it is neither `concurrent` nor `serial`) is enforced by the type system. The runner rejects an unknown string when it builds the config.
- **When several calls in one turn ask for a reset**, the first in time wins, as in Python.

### Spec points that are unclear (not changed)

- `ctx.append` in a `context` hook now fails with `The session is opening, so nothing can be appended yet.` A new session's first entry must be its `context` entry, and the store has no session yet. `plugins.md` does not say what happens here.
- `Ctx` is one type in Rust, so `request_reset` is also reachable from a hook. The loop takes it after the turn's calls either way.

### Size

The loop in `Agent::run` is about 75 lines. `agent.rs` grew from 690 to 749 lines while gaining concurrency and stops, and `plugin.rs` stayed about the same. The crate as a whole grew by about 500 lines, mostly the OpenAI provider, the shared HTTP helper and the runner's new formats.
