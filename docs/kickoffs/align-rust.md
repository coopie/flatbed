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
