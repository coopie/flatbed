# Kickoff: the TypeScript core and the conformance suite

You are building flatbed's first implementation of the core, in TypeScript, together with the conformance suite every later implementation will be tested against. Everything else in flatbed builds on this piece, so make it small, clear and exactly to the spec. Read `AGENTS.md` and the docs it lists, the whole of `docs/spec/`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Guidance

- **The package is `ts/packages/core`, named `@flatbed/core`,** in a pnpm workspace rooted at `ts/`. No runtime dependencies. Erasable TypeScript only, so `node --test` runs the source directly on Node 24, and `tsc --noEmit` in strict mode checks it. Aim for a few files a reader can take in one sitting: types, session store, rendering, the loop with the tool runner, providers. The loop should read top to bottom in about one screen.
- **Stores.** A file store at `<root>/<agent>/<session>.jsonl`, and an in-memory store for tests, behind one small interface that a Postgres store can implement later (`ts/packages/core` will not have one; the example app will).
- **Providers.** `faux`, `anthropic` and `openai`, each one file over `fetch`. The Anthropic adapter follows `docs/spec/providers.md`, including structured output for `outputSchema`; check the current Messages API field names against Anthropic's docs rather than from memory. Read `../otherworldly-agent/agent_host/src/host/loop.ts` and `events.ts` and `../perso/src/agent/loop.ts` for a loop that already works, and copy ideas, not files.
- **The conformance suite** lives at `conformance/scenarios/` at the repo root, as `docs/spec/conformance.md` describes. Write about twelve scenarios that cover the spec: a plain answer, a tool call, an unknown tool, a schema failure, a tool that throws, two calls in one turn, the reset tool and the next session's header and opening notice, the soft and hard budget, a stop, crash repair, delivery between turns, and a rewind. The TypeScript runner is `ts/packages/core/conformance.ts`, run with `node ts/packages/core/conformance.ts`.
- **When the spec is unclear or wrong,** change the spec and the scenarios in the same commit, and list each change in your write-up. Python and Rust will be written from the spec alone, so it must stay true.
- **A small CLI,** `ts/packages/core/cli.ts`: `chat <agent>` for a terminal conversation with a real model, using a file store under `data/` at the repo root, and `view <session-file>` to print a session as the model would see it. Keep it rough and say so at the top.
- **`scripts/check.sh`** at the repo root, with a `ts` section that installs, type-checks, runs the tests and runs the conformance runner. Leave clear places for `python` and `rust` sections, which later pieces fill in.
- **One live check.** With `FLATBED_LIVE=1`, a test runs one short real conversation through the Anthropic provider with `claude-sonnet-5-5`, including one tool call. Read `ANTHROPIC_API_KEY` from `.env` at the repo root. Never print, log or commit a value from `.env`. Run it once or twice, not in a loop.

## Done when

`scripts/check.sh ts` passes, the runner prints `ok` for every scenario, the live check is written and skips cleanly, and `chat` holds a short conversation. The spec matches what you built.

## Time and setting

Work for at most two hours. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Run long commands in the foreground one at a time, and do not end your turn while anything you started is still running.

## Write-up
