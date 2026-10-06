# Kickoff: the personal assistant example

You are building the example that shows what flatbed is for: a small web app where each person has a personal assistant agent. The agent keeps its own documents, reads the person's mail and calendar, and when it wants to send an email or create an event, it proposes it, with its reasons, for the person to accept, edit or deny. It is a showcase for two to four people, so make it clear and small rather than complete. Read `AGENTS.md` and the docs it lists, `docs/design.md`, the READMEs of every package in `ts/packages/`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Context

Sam has built this twice already. Borrow freely, copying ideas and small modules rather than whole files:

- `../perso/` is the closest: Gmail and Calendar in `src/google/`, proposals in `src/proposals/` with cards derived from a schema, the supervisor on proposals, and `docs/google_setup.md`. Its `docs/architecture.md` explains the shape.
- `../otherworldly-agent/` has the panel this should feel like: an approvals queue, a session viewer that shows what the model saw, and a docs editor with history, under `src/routes/(app)/doves/`. Its copy is in `agent_host/docs/panel-copy.md`.

The app shows flatbed's layers working together: the core loop and sessions, the docs plugin for the agent's memory and timeline, the supervisor checking each proposal, and a plugin of the app's own for Google and proposals.

## Guidance

- **Where and what.** `examples/assistant/`, a SvelteKit app on the Node adapter with Svelte 5, in TypeScript, depending on the workspace packages. Plain CSS on the tokens in `docs/design.md`. No component library.
- **Storage** is Postgres, from `DATABASE_URL` in `.env` at the repo root (an empty Supabase database), in a schema of the app's own, `assistant`, created by plain SQL migration files the app runs at start. Implement the core's session store and the docs plugin's store on it. Tests use a separate schema they create and drop.
- **People.** Each person signs in and has one agent. In demo mode, which is the default, sign-in is a choice between two invented people and Google is replaced by invented fixture mail and calendar, so the app runs with only `DATABASE_URL` and `ANTHROPIC_API_KEY`. With Google configured, sign-in is Google OAuth limited to an allow-list of addresses, and the same consent grants the Gmail and Calendar scopes perso uses. Sam's existing Google client is a desktop client, which works for local development; say in the README that Cloud Run needs a web client, and what Sam must do to make one. Do not sign in to any real Google account yourself.
- **The agent.** Each person's agent runs on `anthropic/claude-opus-5-5` with the docs plugin (seed an invented soul, guidelines and a profile of the person), read tools for mail and calendar, and a proposals plugin of the app's own. Proposing to send an email or create an event stores a proposal with the agent's reasons and returns at once, saying the person will decide. The person's decision reaches the agent as an event, and the agent runs again. Only an accepted proposal sends anything, and in demo mode it goes to a fake outbox. The supervisor checks every email proposal with an invented spec, in shadow mode, and its verdict shows on the card.
- **When the agent runs**: when the person sends a message, when they decide a proposal, and when `/api/tick` is called, which a scheduler can call to have agents check for new mail. Use a Postgres advisory lock so an agent never runs twice at once. Stream entries to the open page with server-sent events from the core's `onEntry` hook.
- **Pages**, each short:
  - chat
  - proposals: what the agent wants to send, why, and the supervisor's checklist, with accept, edit and deny
  - documents: list, read and edit with history, and pin
  - sessions: each past session as the model saw it, with its context sections, messages, tool calls and resets
  - the timeline
- **Deploy.** A `Dockerfile` and `deploy.sh` for one Cloud Run service, reading secrets from Secret Manager. Write them and check the image builds if Docker is available; do not deploy.
- **README** for the example: what it shows, how to run it locally in demo mode in a few commands, how to connect Google, and how to deploy.
- **See your work.** The key in `.env` is revoked, so drive the app end to end in demo mode with the faux provider: add a `FLATBED_MODEL` setting (default `anthropic/claude-opus-5-5`) and a scripted faux mode for demos, then send a message that leads to an email proposal, accept it, and see it in the fake outbox. Take screenshots of each page, light and dark, into `examples/assistant/screenshots/`, which the lead will use in a walkthrough. Check the layout at phone width.
- **Tests** at the boundaries: the Postgres stores pass the same behaviour the core's file store does, and a faux-driven run from message to proposal to decision to the outbox works without a browser.

## Done when

The app runs locally in demo mode from the README's commands, the end-to-end run above worked with the faux provider, `scripts/check.sh` passes with the app's checks added, and the screenshots are in place.

## Time and setting

Work for at most three hours. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Change the packages in `ts/packages/` only when you must, and say so in the write-up. Never print, log or commit a value from `.env`, and put no real person's data in fixtures. Run long commands in the foreground one at a time, and stop any server you started before you finish.

## Write-up

`examples/assistant/` is a SvelteKit 2 app (Svelte 5, Node adapter) on Postgres, in schema `assistant`. Each person's agent has the docs plugin, mail and calendar read tools, the app's proposals plugin, `supervisorGuard` in shadow mode on `propose_email`, and a stream plugin feeding server-sent events. It has the five pages, Google mode, a Dockerfile, `deploy.sh` and an `assistant` section in `scripts/check.sh`. Nothing in `ts/packages/` changed; `ts/pnpm-workspace.yaml` now includes the app.

Choices someone could make differently:

- SvelteKit 2, not 3: Kit 3 wants TypeScript 6 and the workspace is on 5.9.
- Entries go in `json` columns as text, since `jsonb` sorts keys.
- The lock is `pg_advisory_xact_lock`, holding a transaction for the whole run, and the client sets `prepare: false`. `DATABASE_URL` is Supabase's transaction pooler, where prepared statements hung every run.
- `faux/demo` is a scripted Provider in the app that plays one exchange per demo person and passes every supervisor item.
- The proposal finds its call id by matching name and input, since a tool's `run` is not given it.
- `@flatbed/*` stay unbundled, since the supervisor reads its schema from disk.

Commands: `scripts/check.sh` printed `== all checks passed`, with the app's 3 tests passing. In the browser pane I sent the demo message, edited the subject, accepted, and saw it in the outbox. `scripts/screenshots.ts` (headless Chrome) wrote 36 screenshots: every page, light and dark, desktop and 390 px.

Left: Docker was not running, so the image is unbuilt. Google mode is untested. Live updates assume one instance.

**How it went.** The pooler cost most of an hour: two hangs that looked like my lock. Killed test runs left two backends idle in a transaction, which I could not end; they should time out. The pane's emulated viewport misplaced clicks and clipped screenshots. An orphaned `node build` (pid 29671, not listening) sits in the app folder; I am not sure it is mine. Worth a decisions entry: `json` over `jsonb`, and the pooler settings.
