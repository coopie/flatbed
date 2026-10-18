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
