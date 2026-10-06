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
- **See your work.** Run the app and drive it end to end in demo mode with a real model at least once: send a message that leads to an email proposal, accept it, and see it in the fake outbox. Take screenshots of each page, light and dark, into `examples/assistant/screenshots/`, which the lead will use in a walkthrough. Check the layout at phone width.
- **Tests** at the boundaries: the Postgres stores pass the same behaviour the core's file store does, and a faux-driven run from message to proposal to decision to the outbox works without a browser.

## Done when

The app runs locally in demo mode from the README's commands, the end-to-end run above worked with a real model, `scripts/check.sh` passes with the app's checks added, and the screenshots are in place.

## Time and setting

Work for at most three hours. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Change the packages in `ts/packages/` only when you must, and say so in the write-up. Never print, log or commit a value from `.env`, and put no real person's data in fixtures. Run long commands in the foreground one at a time, and stop any server you started before you finish.

## Write-up
