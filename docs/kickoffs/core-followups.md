# Kickoff: core follow-ups, in all three languages

You are making a few small changes to the core that the plugins need, in TypeScript, Python and Rust together, so that the three stay in step. The lead has already written the spec changes; your job is to make the suite test them and all three implementations pass. Read `AGENTS.md`, the whole of `docs/spec/`, the three implementations (`ts/packages/core`, `python/flatbed`, `rust/flatbed`), and then this brief. When you are done, add your write-up at the bottom of this file.

## The changes, already in the spec

Run `git log -p -1 -- docs/spec` to see them. In short:

1. **A plugin hook that throws** gives its call an error result, `The <plugin> plugin failed: <message>`, instead of failing the run. Rust and TypeScript currently fail the run.
2. **A parent for an agent's first session**, from the agent's configuration, and `parent.agent` and the `supervise` reason in the header.
3. **`signal` on the tool context**, the run's stop signal.
4. **A newest session holding only a header** is treated as open, and the run writes its missing `context` entry and opening notice.

## Guidance

- Add conformance scenarios for 1, 2 and 4, extending the scenario format in `docs/spec/conformance.md` as little as you can: a test plugin hook that throws, an agent `parent` in the scenario's agent config with the header checked, and a way to start from a header-only session. 3 is tested in TypeScript only, with a unit test.
- In TypeScript, also export the escaping functions from `@flatbed/core`, `escapeText` and `escapeAttr`, which four plugins copy today. Do not change the plugins; the next piece does.
- Keep each implementation's change as small as it can be, in that implementation's existing style.

## Done when

`scripts/check.sh` passes in full, every implementation prints `ok` for every scenario, and the spec says exactly what the code does.

## Time and setting

Work for at most 60 minutes. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Touch only the three cores, the conformance suite and the spec. The API key in `.env` is revoked; do not look for another, and never print a value from `.env`. Run long commands in the foreground one at a time.

## Write-up
