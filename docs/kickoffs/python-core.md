# Kickoff: the Python core

You are writing flatbed's core in Python, from the spec. It is a reference implementation: a reader who knows Python should be able to learn how an agent harness works by reading it top to bottom. Read `AGENTS.md` and the docs it lists, the whole of `docs/spec/`, the scenarios in `conformance/scenarios/`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Guidance

- **Write it from the spec, not from the TypeScript.** The point of a second implementation is to prove the spec is enough. When the spec is unclear, check `ts/packages/core` to see what was meant, then fix the spec so the next reader does not need to, and list each fix in your write-up.
- **The package** is `python/` with a `pyproject.toml`, managed with uv, Python 3.13, importable as `flatbed`. The standard library only: `urllib.request` or `http.client` for HTTP, `json`, `dataclasses` or `TypedDict` for types, `asyncio` only if it makes the loop clearer than threads. Keep it to a few modules: types, store, render, loop, providers.
- **Providers**: `faux` and `anthropic`, as the spec describes.
- **Stores**: the file store, with the same layout as the spec, and an in-memory one. A session written by Python must be readable by TypeScript and the other way round; add one test that reads a session file the TypeScript core wrote, checked in as a fixture.
- **The conformance runner** is `python/conformance.py`, run with `uv run python conformance.py` from `python/`, printing as the spec says. Every scenario must pass.
- **A small CLI**, `python -m flatbed chat <agent>` and `view <file>`, as rough as the TypeScript one.
- **`scripts/check.sh`**: fill in the `python` section: `ruff format --check`, `ruff check`, the unit tests and the conformance runner.
- **One live check** with `FLATBED_LIVE=1`, through Anthropic with `claude-sonnet-5-5`, reading `ANTHROPIC_API_KEY` from `.env` at the repo root. Never print, log or commit a value from `.env`.

## Done when

`scripts/check.sh python` passes, every scenario prints `ok`, and the live check is written and skips cleanly; the key in `.env` is revoked, so the lead runs it in the morning.

## Time and setting

Work for at most two hours. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Other agents are working in other worktrees at the same time, including one on the Rust core; touch only `python/`, the `python` section of `scripts/check.sh`, and the spec where it needs fixing. Run long commands in the foreground one at a time.

## Write-up

**What changed.** `python/` is the core in Python 3.13, standard library only: `types`, `store` (file and memory), `render`, `loop` (a `Runner` per agent, with `deliver` and `run`), `providers/faux` and `providers/anthropic` over urllib, plus `env`, a rough CLI (`python -m flatbed chat|view`) and `conformance.py`. All 24 scenarios pass, after core-fixes merged. `scripts/check.sh python` runs ruff format, ruff check, unittest and the runner.

**Choices.** The code is synchronous. Tool calls run one at a time, which the spec allows, and `StopSignal` wraps a `threading.Event`, so a stop also ends a backoff wait. Plugins are a dataclass of optional hooks. Tools are looked up in the frozen `context` entry, with their code from the plugins, as the spec says. TypeScript looks them up in the plugin map. Tests cover the Anthropic translation, a session the TypeScript core wrote, and the lines Python writes; by hand, `node cli.ts view` read a Python session. The live test skips without `FLATBED_LIVE=1`; I did not run it.

**Commands.** `scripts/check.sh python` printed `All checks passed!` twice, `Ran 12 tests ... OK (skipped=1)`, 24 `ok` lines and `== all checks passed`.

**Spec fixes.** I made one: a conformance `crash` entry goes after the newest session's last entry, with a fresh `id` and `at`. Core-fixes settled the rest.

**Left out.** Redacted thinking blocks are dropped. No OpenAI provider.

**How it went.** The spec was enough for the first 14 scenarios; I read `loop.ts` only to check needs-run and the adapter. Building to the lead's note before core-fixes merged saved most of the rework. TypeScript's `newSessionId` keeps a later random hex in the same second rather than adding one; both sort correctly. The spec does not say what to do with a newest session that holds only a header, after a crash between create and the first append.
