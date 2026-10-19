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

**What changed.** `examples/playground/` is the playground: a Vite app with Svelte components (no SvelteKit, since the site is static files plus one Worker and a router or server would add nothing) and one Worker in `worker/`. The agent is built once in `src/lib/agent.ts`, for the page and the recording script: core on Haiku 4.5, the template's role, `docsPlugin` with the template's seeds and `folders`, the supervisor guard choosing a spec with `writeTarget`, and `fetch_page` to the press template's contract. Sessions and documents live in IndexedDB (`src/lib/stores.ts`). The pages are the picker, each card in its own `look.css` (scoped to `[data-template]`), and the project page: chat with rulings inline, folders and modes, document history, sessions as the model saw them, download as a zip, reset, reveal. `scripts/record.ts` records `recordings/<id>.json`; `recordings/holmes.json` is a real run with one passed casebook ruling. `scripts/check.sh playground` runs svelte-check, the tests and the build. The README covers running, recording and deploying. I built on my own shims first, then moved to main's folder modes and guard references and removed the shims and the placeholder template.

**Choices someone could make differently.** The supervisor gets the document as the write leaves it plus every document in read and sealed folders. For Holmes that includes `yard/`, which is more than the lead named. Revealing a folder delivers its documents as a `reveal` event, since `read_doc` only opens it from the next session; Haiku ignored the reveal until the event said plainly that the folder was open. The Worker adds `GET /api/status` so a page can open read-only. Spend is counted after each call, at Haiku 4.5's list prices, in one non-atomic KV key.

**How I know it works.** Eight Worker tests cover the guards (forced model, capped tokens, dropped fields, no server tools, size, rate limit, budget to read-only, private addresses and redirects). Under `wrangler dev`, in the browser pane: the placeholder template's supervisor refused an all-day discount and passed an opening-hours notice. Download gave a valid zip and reset cleared the project. Holmes recorded with a passed casebook ruling. Press read six pages of a real site in shadow mode. The screenshots are in `screenshots/`. `scripts/check.sh playground` and `ts` both pass.

**What is left.** Recording the real examples for both templates, including a refused write. Making the KV namespace and deploying (README, Deploy). Assistant text shows as plain text with its Markdown unrendered. I made about 55 Haiku calls, slightly more than the few dozen the brief allowed.

**How it went.** Writing the folder and review shims first, then dropping them when main landed, cost perhaps 20 minutes, but it meant the page worked before the merge. The lead's note about giving the one-call supervisor its material saved a round of confused verdicts. Two things slowed me down. Workers refuse any non-handler export from the entry module, which the first `wrangler dev` showed. And the docs README says an unsealed folder reaches the agent "from its next session", which is easy to miss in a chat-shaped app. The template format doc could say how `look.css` should treat `[data-theme]` selectors, since press and Holmes wrote them differently.
