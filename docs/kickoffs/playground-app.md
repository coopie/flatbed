# Kickoff: the playground app

You are building the playground: a public page where anyone can try a flatbed agent doing knowledge work, in the browser, with no sign-in and nothing stored on a server. `docs/playground.md` is the design Sam agreed; read it closely. Read also `AGENTS.md`, `docs/design.md`, `docs/kickoffs/_template-format.md`, the READMEs in `ts/packages/`, and `examples/assistant/`, whose pages (chat, documents with history, sessions as the model saw them, the supervisor's checklist on a card) are the closest thing to what the playground shows. When you are done, add your write-up at the bottom of this file.

## Context

Two other builders are working at the same time. One adds folder modes to `@flatbed/docs` and makes the packages load in a browser; until that lands, a thin local shim is fine, and the lead will tell you when to merge `main`. The other two are writing the Holmes and press office templates in the shared format; build against a small placeholder template of your own until they land.

## What to build

- `examples/playground/`: a static front end and one Cloudflare Worker that serves it, with `/api/complete` and `/api/fetch` as the design describes, including every spending guard. Run it locally with `wrangler dev`, giving the Worker `ANTHROPIC_API_KEY` from the repo's `.env` through a git-ignored `.dev.vars`. Write a `wrangler.toml` and a README that says how Sam deploys it, without deploying.
- The agent in the page: `@flatbed/core` with IndexedDB session and document stores, a provider that calls `/api/complete`, the docs plugin with the template's folders, the supervisor guard on reviewed folders, and the `fetch_page` tool, which saves each page into `sources/`.
- The pages: a picker of templates, each card in its own look; a project page with the chat, the folders and their documents (marked with their mode), the supervisor's rulings as they happen, and each session as the model saw it; download as a zip of Markdown; reset. A read-only mode for when the day's budget is spent, which still shows each template's recorded example project.
- A way to record an example project: run a template with a real model once and save it as a static file the site ships. Record one for your placeholder; the lead records the real ones later.

## Guidance

- Use the framework the repo already uses, SvelteKit, unless a plain Vite app is clearly simpler for a static site plus one Worker; say what you chose.
- The design doc's frame is `docs/design.md`'s look; each template's `look.css` styles its card and its project inside that frame.
- Keep it small enough to read: the playground is itself an example of building on flatbed.

## Done when

`wrangler dev` serves the playground locally; a visitor can pick the placeholder template, chat with a real Haiku model through the proxy, see a supervisor ruling on a reviewed write, download the project and reset it; the guards are tested; and `scripts/check.sh` has a `playground` section that passes. Take screenshots of the picker and a project, light and dark, desktop and phone, into `examples/playground/screenshots/`.

## Time and setting

Work for at most three hours; stop and write up what you have when you reach it. Sam is around today; for a choice that would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Keep live model calls to what you need to check it works: a few dozen Haiku calls at most. Never print a value from `.env`. Stop any server you start before you finish. Never use em dashes in anything you write.

## Write-up
