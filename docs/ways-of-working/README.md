# Ways of working

You are reading this because you are about to change flatbed. Most changes are made by coding agents working from a short brief, and the lead, Sam or an agent he delegates to, reads every change before it merges. This page says how we work, so that every change comes out the same shape and the next person can pick it up.

We value four things: the smallest thing that works, complexity that has earned its place, a quick way to see your work, and docs that stay high level and say why. flatbed is meant to be read as an example of how to build an agent, so simplicity matters more here than in most projects. When a reader cannot hold a module in their head, it is too big.

## Starting a piece of work

A piece of work starts from a brief in `docs/kickoffs/`. Read `docs/overview.md` and the spec, skim `docs/decisions.md` for a choice that already covers your question, then read the brief. Restate the task to yourself in one line.

When two readings of the brief would lead to different work, ask the lead before you build. If nobody is there to answer, add a `## Question for the lead` section at the bottom of the brief with the question and your best guess, then carry on with the guess, unless getting it wrong would waste most of the work.

Keep each change to what was asked, and put anything else you notice in your write-up as a suggestion. Every brief has a time limit. When you reach it, stop and write up what you have, including what is left.

## How we build

Build the smallest thing that works. Complexity has to earn its place, usually through a second use. An interface with one implementation, a setting nobody asked for and a module holding one function all cost more to carry than to add later.

The spec comes first. When an implementation needs behaviour the spec does not describe, change the spec and the conformance suite in the same change, and say so in the write-up. The three implementations stay in step through the suite, not through reading each other's code.

When a piece of code has to behave differently for two callers, pass the difference in, as a value or a function, rather than adding a flag for the code to check. Plugins are how flatbed does this at the top level: the core never knows which plugins exist.

Put care in proportion to how central the code is. The core is finished work: named well, handling the errors that can happen, and asserting where a case cannot happen. A one-off script may be rough, as long as it says so at the top.

Type what is ours and worth holding, such as entries and messages, and let data that is passing through pass through as data. Check data where it enters from outside our control, such as a model's response or a tool's input, and trust it after that.

Write code a reader can follow from top to bottom. Let the code say what it does and the comment say why.

## Stack

- **TypeScript** in `ts/`, a pnpm workspace of small packages named `@flatbed/<name>`. Strict mode, and erasable syntax only (no enums, no parameter properties, no namespaces), so Node 24 runs the source directly. `tsc --noEmit` checks types and `node --test` runs the tests.
- **Python** in `python/`, managed with uv. Python 3.13, the standard library first, `ruff` for format and lint, `unittest` for tests.
- **Rust** in `rust/`, a Cargo workspace on the stable toolchain. `cargo fmt`, `cargo clippy` and `cargo test`.
- **The example app** in `examples/assistant/`: SvelteKit on Node, plain CSS on the tokens in `docs/design.md`, Postgres for storage.

Talk to model providers over plain HTTP rather than through their SDKs. It keeps the core free of dependencies and the three implementations alike. Add a dependency when it saves work you can name.

## Tooling

- **One check script.** `scripts/check.sh` runs every implementation's format, lint, types and tests, then the conformance suite against each. It is the gate before a merge. Each language has its own section, and `scripts/check.sh ts` runs one.
- **See your work.** `flatbed view <session>` in each implementation, or the example app's session page, shows a session as the model saw it. Use it when a run surprises you.
- **Script a workflow the second time you do it**, in `scripts/`, and mention it in your write-up.

## Testing

Keep the tests few and useful. The conformance suite in `conformance/` is the main test of every implementation: it drives the loop with a scripted fake model and checks the session that comes out. Add a scenario when you add behaviour to the spec. Unit tests cover what the suite cannot reach, such as a provider adapter's translation.

Tests that call a real model are skipped unless `FLATBED_LIVE=1`, so the ordinary run is fast, free and passes on a fresh clone. Live runs read `ANTHROPIC_API_KEY` from `.env` at the repo root. Never print, log or commit a value from `.env`.

## Docs and decisions

Docs are how one session hands its understanding to the next, so keep them true.

- **What we are building, why, and where we are** goes in `docs/overview.md`. Its *Where we are* section is a lightly held plan. Rewrite it whenever the plan changes.
- **The core's behaviour** goes in `docs/spec/`. The spec is the contract between implementations, so it is the one place for low-level detail such as field names.
- **A choice another builder could reasonably have made differently** goes in `docs/decisions.md`.
- **How a plugin or library works** goes in its own README, beside its code.

Rewrite a state doc so it says how things are now. Add to a history doc, such as the decisions, and leave what is there as it was. When a conversation settles something, write it down before the conversation ends.

## Finishing a piece of work

Run `scripts/check.sh` in full and fix what it finds. Commit on your branch as you go, with messages that say what changed. Then write up the piece at the bottom of its brief, in 300 words or fewer:

- what changed and why
- the choices you made that someone could have made differently
- the commands you ran and what they printed
- what you left out on purpose, and what is left
- **How it went**: what slowed you down, where the docs or the spec were wrong, missing or misleading, the tool you wished you had, and what you would change about the brief or this page

## Reviewing and merging

The lead reads every write-up and every change, and a review agent reads each wave of work before it merges, findings first. The lead fixes small findings directly and sends larger ones back.

After the merge, delete the brief, since git keeps it. Then act on *How it went*: fix a doc that misled, write a brief for a missing tool, and rewrite this page when the same trouble comes up twice.

## Habits worth trading for better ones

- **Keep the core small.** When a feature could be a plugin, make it one. The core's size is the point of flatbed.
- **Test what matters most.** One conformance scenario that shows a reset carries over correctly tells the next reader more than ten unit tests on helpers.
- **Report plainly.** Say which command you ran and what it printed.
