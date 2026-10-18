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
