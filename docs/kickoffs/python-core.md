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
