# Kickoff: align the Python core

The three cores drifted apart where the conformance suite could not see, so the spec changed on 18 October: one host API, async throughout, concurrent or serial tool calls by setting, and exact stop behaviour. You are bringing the Python core in line. A TypeScript builder is writing the new scenarios at the same time; build to the spec, then merge `main` when the lead says the scenarios have landed, and make them pass. Read `AGENTS.md`, the whole of `docs/spec/` (`git show 3fedbe5` shows what changed, and `host.md` is new), `python/flatbed`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Context

A read-only comparison of the three cores found Python's stop design the best of the three: `unless_set` races a model call against the stop, so a provider that ignores cancellation still lets the run end. The same comparison found, for Python:

- the store is synchronous, so file writes block the event loop
- the host-facing names differ from the spec's: the config is `Agent` and the agent is `Runner`
- `StopSignal.set` is safe only on the loop's own thread, where the spec says a stop can be set from any task or thread
- there is no OpenAI provider, and the provider options differ (`url` is a full URL)
- a stop during a turn's calls does not yet follow `host.md`: unstarted calls should not start

## Guidance

- Make the store async, with the file store doing its I/O off the event loop.
- Use the spec's names: `AgentConfig`, `Agent`, `deliver`, `run`, and `toolExecution` and `max_concurrent_tools`, in Python's snake_case.
- Add the OpenAI provider, with the shared options `api_key`, `base_url` and `timeout` on both providers, and the shared retry rules.
- Teach the conformance runner the format additions in `docs/spec/conformance.md`.
- Keep it plain modern async Python a reader can follow from top to bottom.

## Done when

`scripts/check.sh python` passes with every scenario, including the new ones once they land, and the live check passes once.

## Time and setting

Work for at most 90 minutes; stop and write up what you have when you reach it. Sam is around today. If a choice would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main` (merging `main` into your branch is expected). The Anthropic key in `.env` works; never print a value from it. Touch only `python/`, the `python` section of `scripts/check.sh`, and the spec where it is unclear, saying so in the write-up. Run long commands in the foreground one at a time.

## Write-up

The Python core now follows the 18 October spec. The changes:

- The host API uses the spec's names: `AgentConfig`, and `Agent(config, store=, providers=)` with `deliver(event, parent_id=)` and `run(stop=)`. It also adds `tool_execution` (`concurrent` or `serial`) and `max_concurrent_tools`.
- `StopSignal.set` works from any thread. It wakes each waiter on that waiter's own loop. Calls in a turn wait their turn for a slot, in call order. A call that has not started when the stop is set does not start, and gets the repair text. The loop already abandoned hung model calls through `unless_set`, and still does.
- Stores are async, and `FileStore` does its file I/O with `asyncio.to_thread`. Entries are added under an `asyncio.Lock`, so that calls running together cannot both build on the same head entry.
- There is an OpenAI provider. Both providers take `api_key`, `base_url` and `timeout`, and share one POST with the spec's retry rules (`providers/http.py`).
- The conformance runner handles every new format addition, and gives each scenario 10 seconds. The needs-run check now looks past stop notices that follow the soft-limit notice.

Choices someone could have made differently:

- When two hosts set the stop, the first one is recorded, as with `AbortController`.
- A `stopAfter` stop is set from a `threading.Timer`, so the suite tests that a stop works from another thread.
- The `hang` fake ignores its own cancellation as well as the stop.
- The default base URLs match TypeScript: Anthropic's has no `/v1`, and OpenAI's ends in `/v1`. The spec does not say this. I did not change the spec.

Commands and output:

- `scripts/check.sh python` printed `ok` for all 37 scenarios, 21 tests ran with the live test skipped, and it ended with `== all checks passed`.
- `FLATBED_LIVE=1 uv run python -m unittest tests.test_live` ran 1 test, `OK`.
- I did not live-test the OpenAI provider, because there is no key. Unit tests cover how it translates requests and responses.

**How it went**: smoothly. The brief and the spec were clear. The 18 October entry in `docs/decisions.md` supersedes the earlier line saying file appends need no thread, and that older entry still names `Runner`. It is history, so I left it. An OpenAI key in `.env` would let the new adapter be checked live.
