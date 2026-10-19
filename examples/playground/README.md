# The playground

A public page where anyone can try a flatbed agent doing knowledge work, with no sign-in and nothing stored on a server. [docs/playground.md](../../docs/playground.md) is the design. The agent runs in the visitor's browser, and one Cloudflare Worker serves the site and passes model calls to Anthropic with Sam's key.

It is also an example of building on flatbed, so it is kept small enough to read in one sitting.

## How it fits together

- **The page** is a plain Vite app with Svelte components, without SvelteKit: the site is static files plus one Worker, so a router and a server would add nothing. Routes are hash routes, in [src/lib/route.svelte.ts](src/lib/route.svelte.ts).
- **The agent** is built in [src/lib/agent.ts](src/lib/agent.ts), by the page and the recording script alike: flatbed's core loop on Claude Haiku 4.5, with the template's role as its first section, `@flatbed/docs` with the template's seeds and folders, `@flatbed/supervisor`'s guard on each reviewed folder, and `fetch_page` when the template names it. The guard gives its one-call supervisor the document as the write would leave it and every document in the template's read and sealed folders, since the supervisor sees only the agent's session.
- **Storage** is IndexedDB, in [src/lib/stores.ts](src/lib/stores.ts): a session store and a document store keyed by template, so each browser has one project per template. A snapshot is the same data as JSON, used for the download and the recorded examples.
- **Revealing** a sealed folder makes it a read folder for the agent's next session, and delivers its documents as a `reveal` event with the visitor's next message, so the agent can use them at once.
- **The Worker**, [worker/api.ts](worker/api.ts), has three endpoints. `POST /api/complete/v1/messages` passes a model call on: the page's provider is core's Anthropic adapter with `/api/complete` as its base URL. `GET /api/fetch?url=` reads one public page as Markdown and links, for `fetch_page`. `GET /api/status` says whether the day's budget is spent. Everything else is a file from `dist/`.
- **The templates** are in `templates/`, in the format of [docs/kickoffs/_template-format.md](../../docs/kickoffs/_template-format.md). Each `look.css` is scoped to its card and project, inside the frame that [docs/design.md](../../docs/design.md) sets.
- **Recorded examples** are in `recordings/<template>.json`. The picker links to one when it exists, and when the day's budget is spent they are what a visitor can still browse.

## The spending guards

All in the Worker, and tested in [worker/worker.test.ts](worker/worker.test.ts):

- The model is always `claude-haiku-4-5`, whatever the page asks for.
- Only the fields the agent and the supervisor send are passed on. Tools must be custom tools with an input schema, so the key cannot reach a server tool such as web search.
- A request is at most 256 KB, `max_tokens` at most 4,096, and a response at most 256 KB.
- Each IP address may make 30 calls a minute, through Cloudflare's rate-limit binding, with model calls and page fetches counted apart.
- Each call's cost, from its usage at Haiku 4.5's prices, is added to one KV key a day. Once the day's total reaches `DAILY_BUDGET_USD`, model calls and page fetches are refused and the page opens read-only. KV has no atomic increment, so calls that finish together can undercount a little; the Anthropic console workspace's spending limit is the backstop.
- Page fetches take http and https on the usual port, refuse private, loopback and link-local addresses, check each redirect the same way, stop at 2 MB and 10 seconds, and are cached for ten minutes.

## Run it locally

From `ts/`, run `pnpm install` once. Then from here:

```sh
pnpm dev
```

This builds the site into `dist/`, writes `.dev.vars` with `ANTHROPIC_API_KEY` from the repo's `.env` (git ignores both, and the script never prints the key), and starts `wrangler dev` at http://localhost:8787. KV and the rate limiter run locally. After changing the page, run `pnpm build` again; `wrangler dev` serves the new files.

`scripts/check.sh playground`, from the repo root, runs the type check, the tests and the build. None of them call a model or the web.

## Record an example project

With `pnpm dev` running in another terminal:

```sh
node scripts/record.ts holmes
node scripts/record.ts holmes --then "Have Watson write up the attic visit as the next chapter."
node scripts/record.ts press --ask https://example.com --shadow
```

It runs the template's agent in memory, through the local Worker, sends the answer to `ask` when the template has one and then its three prompts, and saves `recordings/<template>.json`. `--then` adds messages after the prompts, `--prompts <n>` sends only the first few, `--reveal` opens the sealed folders before the last message, and `--shadow` records the supervisor's verdicts without refusing, which is the way to try a new spec. Read the recording on the site before you commit it: a recording is what visitors see when the budget is gone. A run costs a few cents.

## Screenshots

With `pnpm dev` running, `node scripts/screenshots.ts` saves the picker and a recorded project, light and dark, at desktop and phone width, into `screenshots/`.

## Deploy

Sam deploys from here, signed in with `pnpm exec wrangler login`:

1. Create the KV namespace with `pnpm exec wrangler kv namespace create BUDGET`, and put the id it prints in `wrangler.toml` in place of the zeros.
2. Make an Anthropic API key in its own console workspace, with a monthly spending limit a little above what the playground should ever spend, and give it to the Worker with `pnpm exec wrangler secret put ANTHROPIC_API_KEY`.
3. Set `DAILY_BUDGET_USD` in `wrangler.toml`. At $10 a day, the $100 of credit lasts at least ten days.
4. Run `pnpm build && pnpm exec wrangler deploy`.

The rate limiter's `namespace_id` in `wrangler.toml` is any number unique within the Cloudflare account. To see the day's spend, read the key `spend:YYYY-MM-DD` from the namespace, in millionths of a dollar.
