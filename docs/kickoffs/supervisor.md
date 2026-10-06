# Kickoff: the supervisor library

You are building flatbed's supervisor: a library that hands a whole agent session to another model, with a checklist, and gets back an audited verdict on each item. A host uses it to check a risky tool call before it runs, or to audit a session after it ends. Read `AGENTS.md` and the docs it lists, `docs/spec/sessions.md` and `docs/spec/providers.md`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Context

Otherworldly's agent host already has a supervisor that works. Read `../otherworldly-agent/agent_host/docs/supervision.md` and `src/host/supervision/` there, and `../perso/src/agent/supervisor.ts` with `../perso/supervision/` if it exists. Keep the ideas: a brief with a purpose and a checklist keyed by stable ids; the verdict schema derived from the checklist, with the analysis written before the yes or no for each item; items the host answers in code; and `unavailable` rather than an invented verdict when the model fails. Leave behind anything about email or venues. Note that perso found recent models refuse a forced tool call, so use structured output through the provider's `outputSchema`.

## Guidance

- **The spec is data.** Write a JSON Schema for a supervisor spec, `ts/packages/supervisor/spec.schema.json`, so that a spec can be written in any language or by hand. A spec holds the task it checks, a preamble that tells the supervisor what is going on and what is at stake if it gets it wrong, and checklist items: `id`, `title`, what to look for, `severity` of `block` or `warn`, and optional guidance. Add anything Otherworldly showed is needed, and nothing more.
- **Derive the verdict schema** from a spec: one property per item id, each with `analysis` then `ok`, plus an overall summary. Write the derivation so it is easy to port, since Python and Rust will want it.
- **The single-pass runner** takes a spec, a session's entries, an optional tool call under review and a `complete` function with the shape of `docs/spec/providers.md`. It renders the session as the supervisor should see it, asks once, validates the answer against the derived schema, retries once, and otherwise returns `unavailable`. Define the provider types it needs locally for now; the core is being built at the same time in another worktree, and a later piece will switch to `@flatbed/core`'s types.
- **Leave room for an agent as supervisor.** Shape the runner's interface so that a later piece can supply a supervisor that is itself a flatbed agent with tools, rather than one model call. Do not build that now; say in the README how it would plug in.
- **Example spec.** Include one invented spec, such as checking an email an assistant wants to send, and use it in the tests and the README.
- The package is `ts/packages/supervisor`, `@flatbed/supervisor`, in the same style as the rest of `ts/`: strict, erasable TypeScript, `node --test`, no runtime dependencies unless one saves work you can name. Validate against the derived schema with a small checker of your own if that is under about 80 lines.
- **One live check** with `FLATBED_LIVE=1`, running the example spec against a short invented session through Anthropic's Messages API with `claude-sonnet-5-5`, reading `ANTHROPIC_API_KEY` from `.env` at the repo root. Never print, log or commit a value from `.env`.
- Write `ts/packages/supervisor/README.md`: what a supervisor is for, how to write a spec well (the Otherworldly page has good advice), and how to run one.

## Done when

The tests pass with `node --test` and `tsc --noEmit`, the live check passed once, and the README shows a reader how to write and run a spec.

## Time and setting

Work for at most 75 minutes. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Another agent is building `ts/packages/core` at the same time, so do not touch it or `scripts/check.sh`; if the pnpm workspace files do not exist yet, create minimal ones and expect a merge. Run long commands in the foreground one at a time.

## Write-up

`ts/packages/supervisor` is `@flatbed/supervisor`. It has `spec.schema.json`, `verdictSchema(spec)`, a checker of about 60 lines (`check.ts`), the session renderer (`prompt.ts`), `singlePass` (`run.ts`), local copies of the core types (`types.ts`), an invented spec and session in `examples/`, and a README. I also added minimal `ts/package.json` and `pnpm-workspace.yaml`, which will need merging with ts-core's.

**Choices someone could make differently**

- The checklist is an ordered array, because array order survives every language. Host-answered items are marked `answeredBy: "host"`, and the host passes their answers in as values. I logged this in `docs/decisions.md`, marked for review.
- The verdict is `{ items: { <id>: { analysis, ok } }, summary }`. Nesting means an item can never clash with `summary`.
- A retry sends the same request again. It does not tell the model what was wrong.
- `parseSpec` checks a spec against the schema and also checks that item ids are unique.
- `Supervise` is a function type, so an agent supervisor can be added later as a second function. The README explains how.

**Commands**

- `node --test`: 7 tests, 6 passed, 1 skipped (the live test).
- `tsc --noEmit -p .`: no errors.
- `FLATBED_LIVE=1 node --test live.test.ts`: failed with `401 authentication_error: API key is invalid`. The `.env` line parses as an `sk-ant-api` key, so the key itself looks revoked. **The live check has not passed.**

**Left out:** a host plugin that applies verdicts to tool calls, refusal wording, the redraft loop, gathered material and cache breakpoints on the material.

**How it went:** the brief and the Otherworldly page were clear. The live check needs a working key. Also, nothing has confirmed that the Messages API accepts `output_config.format`, because the 401 came back before the body was checked. The live test's provider is a stand-in and should switch to core's.

## Question for the lead

The `.env` key is rejected as invalid. Can you replace it and run `FLATBED_LIVE=1 node --test live.test.ts` from `ts/packages/supervisor`? My best guess is that the code is right and only the key is wrong.
