# Stack

flatbed's core has three implementations, in TypeScript, Python and Rust, and an example app in TypeScript. They share one host API, in [spec/host.md](spec/host.md), and are async throughout. Where an idiom differs between languages, such as how a stop is made, the behaviour is the same and the conformance suite checks it.

## The languages

- **TypeScript** is in `ts/`, a pnpm workspace of small packages named `@flatbed/<name>`. It uses strict mode and erasable syntax only, with no enums, parameter properties or namespaces, so Node 24 runs the source directly. `tsc --noEmit` checks types and `node --test` runs the tests.
- **Python** is in `python/`, managed with uv. It is Python 3.13 on `asyncio`, using the standard library first and `httpx` for async HTTP, with `ruff` for format and lint and `unittest` for tests.
- **Rust** is in `rust/`, a Cargo workspace on the stable toolchain, async on `tokio` with `reqwest` for HTTP. It uses `cargo fmt`, `cargo clippy` and `cargo test`.
- **The example app** is in `examples/assistant/`: SvelteKit on Node, plain CSS on the tokens in [design.md](design.md), and Postgres for storage. Its [README](../examples/assistant/README.md) says how to run it.
- **The playground** is in `examples/playground/`: a Vite app with Svelte components that runs the agent in the browser, on IndexedDB, and one Cloudflare Worker that serves it and holds the model key. Its [README](../examples/playground/README.md) says how to run, record and deploy it.

Each implementation talks to model providers over plain HTTP, without their SDKs, which keeps the core free of dependencies and the three implementations alike. [decisions.md](decisions.md) has the reasoning. A dependency has tended to earn its place when it saves work you can name, as `httpx` does in Python.

## Checking your work

`scripts/check.sh` runs every implementation's format, lint, types and tests, then the conformance suite against each. It is the gate before a merge. Each language has its own section, so `scripts/check.sh ts` runs one, `scripts/check.sh assistant` checks the example app, and `scripts/check.sh playground` the playground.

The conformance suite, in `conformance/scenarios/`, is the main test of every implementation. It drives the loop with a scripted fake model and checks the session that comes out. Unit tests cover what the suite cannot reach, such as a provider adapter's translation.

## Seeing a session

Each implementation's CLI prints a session as the model saw it, which is the quickest way to understand a run that surprised you:

- `node ts/packages/core/cli.ts view <session-file>`
- `uv run python -m flatbed view <session-file>`, from `python/`
- `cargo run -- view <session-file>`, from `rust/`

The example app's sessions page shows the same view for its agents.

## Live tests

Tests that call a real model are skipped unless `FLATBED_LIVE=1`, so the ordinary run is fast, free and passes on a fresh clone. Live runs read `ANTHROPIC_API_KEY` from `.env` at the repo root, which git ignores.

Never print, log or commit a value from `.env`. Session logs, write-ups and command output are read by other agents and people, so a key that reaches any of them has leaked.
