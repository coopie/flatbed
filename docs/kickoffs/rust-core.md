# Kickoff: the Rust core

You are writing flatbed's core in Rust, from the spec. It is a reference implementation: a reader who knows Rust should be able to learn how an agent harness works by reading it top to bottom. Read `AGENTS.md` and the docs it lists, the whole of `docs/spec/`, the scenarios in `conformance/scenarios/`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Guidance

- **Write it from the spec, not from the TypeScript.** The point of a third implementation is to prove the spec is enough. When the spec is unclear, check `ts/packages/core` to see what was meant, then fix the spec so the next reader does not need to, and list each fix in your write-up.
- **The crate** is `flatbed` in a Cargo workspace at `rust/`, on stable Rust. Keep dependencies few and name what each saves: `serde` and `serde_json` certainly; an HTTP client such as `ureq` for a blocking design or `reqwest` with `tokio` for an async one. Choose blocking unless async makes the loop clearer, since the loop is sequential and tools may run on threads. Plugins and tools are trait objects; keep the traits as small as the spec's hooks.
- **Providers**: `faux` and `anthropic`, as the spec describes.
- **Stores**: the file store, with the same layout as the spec, and an in-memory one. A session written by Rust must be readable by TypeScript and the other way round; add one test that reads a session file the TypeScript core wrote, checked in as a fixture.
- **The conformance runner** is a binary or an integration test in the workspace, run from `scripts/check.sh`, printing as the spec says. Every scenario must pass.
- **A small CLI**, `flatbed chat <agent>` and `view <file>`, as rough as the TypeScript one.
- **`scripts/check.sh`**: fill in the `rust` section: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` and the conformance runner.
- **One live check**, an ignored test run with `FLATBED_LIVE=1`, through Anthropic with `claude-sonnet-5-5`, reading `ANTHROPIC_API_KEY` from `.env` at the repo root. Never print, log or commit a value from `.env`.

## Done when

`scripts/check.sh rust` passes, every scenario prints `ok`, and the live check is written and skips cleanly; the key in `.env` is revoked, so the lead runs it in the morning.

## Time and setting

Work for at most two hours. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Other agents are working in other worktrees at the same time, including one on the Python core; touch only `rust/`, the `rust` section of `scripts/check.sh`, and the spec where it needs fixing. Builds can be slow, so run them in the foreground one at a time and wait for them.

## Write-up

The crate `flatbed` is in `rust/flatbed`, about 1,850 lines of library (types, file and memory stores, rendering, plugins and tools, the loop, faux and Anthropic providers), plus a rough CLI (`cargo run -- chat <agent>`, `view <file>`) and the conformance runner (`cargo run --bin conformance`).

**Choices someone could make differently**

- Blocking, with tools run one at a time. The loop is sequential, and threads would make every plugin `Send + Sync`.
- A hook's `ctx` collects what it appends or delivers, and the loop writes it when the hook returns. No hook holds the session while it changes.
- `run(&mut self)` is the in-process guard. Random ids and ISO times use the standard library, not `rand` or `chrono`.
- The TypeScript fixture was written by the TypeScript core with a throwaway script. The test checks that every line round-trips to the same JSON.

**Spec fixes**, in `416e2a3`:

- `beforeTool` or `afterTool` throwing fails the run, as in TypeScript.
- A custom entry appended during a call lands before the turn's `tool` messages.
- A model naming no known provider fails the run before it touches the session.

I also followed every core-fix change after merging `main`.

**Commands**

- `scripts/check.sh rust`: fmt, clippy and 7 tests passed, with the live check ignored. All 24 scenarios printed `ok`, then `== all checks passed`.
- `cargo test --test live -- --ignored` without `FLATBED_LIVE`: printed `skipped`. I did not run it live.
- The Rust CLI wrote a session with `faux/echo`, and the TypeScript `cli.ts view` printed it the same as Rust's `view`.

**Left out:** full JSON Schema checks, streaming, concurrent tools, cancelling a request already in flight (the stop signal is checked between attempts and during backoff), and the OpenAI provider.

**How it went:** the spec was enough for the loop. My unclear points were hook errors and where appended entries land, both now specced.

## Question for the lead

Should a failing `beforeTool` or `afterTool` fail the run, as TypeScript does and the spec now says? The alternative is an error result the model sees. My best guess is to fail the run, because it is a plugin bug.
