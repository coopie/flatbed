# The playground

A public page where anyone can try a flatbed agent doing knowledge work, with no sign-in and nothing stored on a server. [docs/playground.md](../../docs/playground.md) is the design. The agent runs in the visitor's browser, and one Cloudflare Worker serves the site and passes model calls to Anthropic with Sam's key.

It is also an example of building on flatbed, so it is kept small enough to read in one sitting.

## How it fits together

- **The page** is a plain Vite app with Svelte components, without SvelteKit: the site is static files plus one Worker, so a router and a server would add nothing. Routes are hash routes, in [src/lib/route.svelte.ts](src/lib/route.svelte.ts).
- **The agent** is built in [src/lib/agent.ts](src/lib/agent.ts), by the page and the recording script alike: flatbed's core loop on Claude Haiku 4.5, with the template's role as its first section, `@flatbed/docs` with the template's seeds and folders, `@flatbed/supervisor`'s guard on each reviewed folder, and `fetch_page` when the template names it. The guard's one-call supervisor sees only the agent's session, so it is also given the document as the write would leave it and every document in the folders the agent can see, which includes notes and chapters written before a reset. A document already shown in full in the session is not sent twice.
- **Sealed folders stay sealed from the supervisor too.** Its analysis is shown to the agent and the visitor, so a supervisor that read the Holmes solution could give it away while explaining a refusal, and an instruction not to is a promise a model can break. Without it, the casebook's spoiler check judges whether a chapter claims more than the evidence found so far, which is also all the agent can know.
- **Replies render as Markdown**, through [src/lib/markdown.ts](src/lib/markdown.ts), which escapes the whole reply before it adds its own tags, so no HTML from the model reaches the page.
- **Storage** is IndexedDB, in [src/lib/stores.ts](src/lib/stores.ts): a session store and a document store keyed by template, so each browser has one project per template. A snapshot is the same data as JSON, used for the download and the recorded examples.
- **Revealing** a sealed folder makes it a read folder for the agent's next session, and delivers its documents as a `reveal` event with the visitor's next message, so the agent can use them at once.
- **The Worker**, [worker/api.ts](worker/api.ts), has three endpoints. `POST /api/complete/v1/messages` passes a model call on: the page's provider is core's Anthropic adapter with `/api/complete` as its base URL. `GET /api/fetch?url=` reads one public page as Markdown and links, for `fetch_page`. `GET /api/status` says whether the day's budget is spent. Everything else is a file from `dist/`.
- **The templates** are in `templates/`, in the format of [docs/kickoffs/_template-format.md](../../docs/kickoffs/_template-format.md). Each `look.css` is scoped to its card and project, inside the frame that [docs/design.md](../../docs/design.md) sets.
- **Recorded examples** are in `recordings/<template>.json`. The picker links to one when it exists, and when the day's budget is spent they are what a visitor can still browse.

## The spending guards

All in the Worker, and tested in [worker/worker.test.ts](worker/worker.test.ts):

- Every `/api/` request is rate-limited before anything else runs: 30 a minute through Cloudflare's rate-limit binding, with model calls, page fetches and status checks counted apart. An IPv4 address counts whole; an IPv6 address counts by its first four groups, the /64 one household or server is given, so rotating through it does not help.
- The model is always `claude-haiku-4-5`, whatever the page asks for.
- Only the fields the agent and the supervisor send are passed on. Tools must be custom tools with an input schema, so the key cannot reach a server tool such as web search. Messages may hold only text, tool calls and tool results of text, so an image or document block, whose URL source Anthropic would fetch and bill, is refused.
- A request is at most 512 KB, `max_tokens` at most 4,096, and a response at most 256 KB. The request cap is set by the agent's limits: it resets at 40,000 tokens and stops at 60,000, and a supervisor call carries the session and its references, which with six fetched pages of 12,000 characters comes to about 300 KB. The largest request costs about $0.15.
- The day's spend is kept by one Durable Object, [worker/budget.ts](worker/budget.ts), which checks and adds in one step, so calls that arrive together all count and every location sees the same total. Before a model call the Worker reserves its likely cost, refused once the day's total would pass `DAILY_BUDGET_USD`, and settles the difference when the usage comes back, at Haiku 4.5's prices with five-minute cache writes at 1.25 times the input price and hour-long ones at twice. Once the budget is spent, model calls and page fetches are refused and the page opens read-only. A `DAILY_BUDGET_USD` that is missing or is not a positive number keeps the playground read-only.
- Page fetches take http and https on the usual port, refuse private, loopback, link-local and other special addresses (including IPv4 inside IPv6 and a trailing dot), check each redirect the same way, stop at 512 KB and 10 seconds, keep at most 12,000 characters of text, and are cached for ten minutes. The text is read in one pass over the tags, so a crafted page costs no more than a plain one.

## Run it locally

From `ts/`, run `pnpm install` once. Then from here:

```sh
pnpm dev
```

This builds the site into `dist/`, writes `.dev.vars` with `ANTHROPIC_API_KEY` from the repo's `.env` (git ignores both, and the script never prints the key), and starts `wrangler dev` at http://localhost:8787. The Durable Object and the rate limiter run locally. After changing the page, run `pnpm build` again; `wrangler dev` serves the new files.

`scripts/check.sh playground`, from the repo root, runs the type check, the tests and the build. None of them call a model or the web.

## Record an example project

With `pnpm dev` running in another terminal:

```sh
node scripts/record.ts holmes
node scripts/record.ts holmes --then "Have Watson write up the attic visit as the next chapter."
node scripts/record.ts press --ask https://example.com --shadow
```

It runs the template's agent in memory, through the local Worker, sends the answer to `ask` when the template has one and then its three prompts, and saves `recordings/<template>.json`. `--then` adds messages after the prompts, `--prompts <n>` sends only the first few, `--reveal` opens the sealed folders before the last message, and `--shadow` records the supervisor's verdicts without refusing, which is the way to try a new spec. Read the recording on the site before you commit it: a recording is what visitors see when the budget is gone. A run costs a few cents, and the script ends by saying how many model calls it made, the supervisor's included.

## Screenshots

With `pnpm dev` running, `node scripts/screenshots.ts` saves the picker and a recorded project, light and dark, at desktop and phone width, into `screenshots/`.

## Deploy

Sam deploys from here, signed in with `pnpm exec wrangler login`:

1. Make an Anthropic API key in its own console workspace, and set that workspace's monthly spending limit to $100 or less. It is the backstop if every guard here fails. Give the key to the Worker with `pnpm exec wrangler secret put ANTHROPIC_API_KEY`.
2. Set `DAILY_BUDGET_USD` in `wrangler.toml` to a positive number of dollars. At $10 a day, the $100 of credit lasts at least ten days. Anything else, or leaving it out, keeps the playground read-only, so check the page opens for chat after deploying.
3. Run `pnpm build && pnpm exec wrangler deploy`. The first deploy creates the `Budget` Durable Object from the migration in `wrangler.toml`; there is nothing to create by hand.

The rate limiter's `namespace_id` in `wrangler.toml` is any number unique within the Cloudflare account. The Durable Object keeps the last three days' spend, in millionths of a dollar; `GET /api/status` says only whether today's is spent.
