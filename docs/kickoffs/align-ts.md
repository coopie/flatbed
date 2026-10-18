# Kickoff: align the TypeScript core, and write the suite's new scenarios

The three cores drifted apart where the conformance suite could not see, so the spec changed on 18 October: one host API, async throughout, concurrent or serial tool calls by setting, and exact stop behaviour. You own two parts of the catch-up: the new scenarios that make those behaviours visible to the suite, and the TypeScript core's changes. Python and Rust builders start at the same time, building to the spec; your scenarios are what they will be tested against, so land them early. Read `AGENTS.md`, the whole of `docs/spec/` (`git show 3fedbe5` shows what changed, and `host.md` is new), `ts/packages/core`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Context

A read-only comparison of the three cores found, for TypeScript in particular:

- input is checked against the plugin code's schema, where the spec says the frozen `context` entry's
- whether the soft-limit notice still needs an answer lives in a memory flag, so after a restart the next run idles
- `maxConcurrentTools` below 1 and an unknown model prefix fail inside `run` rather than in `createAgent`
- a provider that ignores the abort signal keeps a stopped run waiting; Python's design, racing the call against the stop, is the one the spec now describes
- provider options and which failures are retried differ from Python and Rust

## Guidance

- **Scenarios first, in one commit of their own**, using the format additions in `docs/spec/conformance.md`. The behaviours worth a scenario each: calls overlap up to the limit when concurrent (`maxRunning`), never overlap when serial, a stop abandons a model call that hangs, a stop during a turn's calls lets the running call finish and gives unstarted calls the repair text, the soft-limit notice is answered by the next run after a stop, two tools sharing a name fail the run, the input check uses the frozen schema after a restart, and the provider receives `effort` and `maxTokens`. Choose timings in the sleep scenarios with room to spare, so the suite stays steady on a busy machine. When the format turns out to need something the spec does not say, change `conformance.md` in the same commit and say so in the write-up.
- **Then the TypeScript core**: `toolExecution`, the stop behaviour in `host.md`, the frozen-schema check, needs-run from the log, validation in `createAgent`, the shared provider options and retry rules, and the duplicate-name failure. Keep the loop readable in about a screen.
- The OpenAI provider stays as it is apart from the shared options.

## Done when

`scripts/check.sh ts` passes with every scenario, and the spec says exactly what the TypeScript core does.

## Time and setting

Work for at most 90 minutes; stop and write up what you have when you reach it. Sam is around today. If a choice would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. The Anthropic key in `.env` works; never print a value from it. Run long commands in the foreground one at a time.

## Write-up

Written 18 October 2026, after about 50 minutes. `scripts/check.sh ts` passes with all 37 scenarios.

### Scenarios

Commit `d85024f` holds only the scenarios, the runner's support for them and the spec changes they needed. There are ten, numbered 28 to 37:

- concurrent calls overlap up to the limit (`maxRunning` 2 with a limit of 2 and three calls of 300 ms)
- serial calls never overlap (`maxRunning` 1)
- a stop abandons a model call that hangs (`hang`, stop after 500 ms)
- a stop during a turn's calls: two running calls see the stop and finish, the unstarted third gets the repair text
- the soft-limit notice is answered after a restart (a `crash` step appends the notice)
- the soft-limit notice is answered after a stop
- two tools named `echo` fail the run, with nothing written
- a plugin tool named `reset` fails the run in the same way
- the input check follows the frozen schema (a `crash` step appends a later `context` entry whose schema differs from the plugin's code)
- the provider receives `effort` and `maxTokens`

The sleep scenarios depend on timing only where it is safe: overlap needs two 300 ms sleeps to start within 300 ms of each other, and both stop scenarios wait for a stop that comes 500 ms in, so they cannot end early.

Spec changes in that commit:

- `conformance.md`: `stopAfter` sets the stop that many milliseconds after the run starts (it used to say "before"); an expected run error is compared exactly; `expect.requests` must match the number of requests; and a scenario fails after 10 seconds, so that a core which waits on a hung call fails rather than hanging the suite.
- `loop.md`: a session still needs a run when only `Stopped by <who>.` notices follow the soft-limit notice. See the question below.

### The TypeScript core

Commit `7fbc399`:

- `toolExecution`: `serial` uses the same limiter with a size of 1.
- Stops: the model call is raced against the stop signal, so a provider that ignores it is left behind. A call that has not started when the stop is set gets `The harness stopped before this tool ran.`, and running calls finish. After a turn with calls, a set stop appends the results and then the stop notice. The run always has a signal, which removes the optional checks.
- The input check uses the schema from the frozen `context` entry.
- Needs-run is worked out from the entries alone; the in-memory `answerNotice` flag is gone.
- `createAgent` rejects `maxConcurrentTools` below 1 and an unknown `toolExecution`, as well as an unknown provider, which it already rejected.
- A plugin tool named `reset` fails with `Two tools are named reset.`
- Providers take `ProviderOptions` (`apiKey`, `baseUrl`, `timeout` in seconds, 600 by default). `postJson` retries when there is no response, including a timeout, and on 408, 409, 429 and 500 and above.
- `providers.md` now says that an unknown provider fails in `createAgent`, matching `host.md`.
- New unit tests cover `createAgent` validation and the 408 and 400 retry rules.

`run` is now about 55 lines.

### Question for the lead

`loop.md` said the soft-limit notice needs an answer "even when the run that appended it was stopped". But every stop writes `Stopped by <who>.` last, and by the needs-run rule that notice needs no answer. So the old wording could not be met. I chose to let only stop notices sit between the soft-limit notice and the end of the path. Python's current check fails scenario 33 because of this. The other choice is to drop "was stopped" from the spec and delete scenario 33.

Another point: rejecting an unknown `toolExecution` value in `createAgent` is not in `host.md`. It would be worth one line there if Python and Rust should do the same.
