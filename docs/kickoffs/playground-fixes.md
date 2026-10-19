# Kickoff: get the playground ready to launch

The playground (`docs/playground.md`, `examples/playground/`) is built, and a read-only review on 19 October found nothing that leaks the key or carries one visitor's content to another, but found the spending guards weaker than they look under load, a way for the supervisor to leak the sealed solution, and size limits that will break the press office. You are fixing those, then recording the two example projects that ship with the site. Read `AGENTS.md`, `docs/playground.md`, `examples/playground/` and its README, and then this brief. When you are done, add your write-up at the bottom of this file.

## What the review found

1. **The daily spend counter** is a read-modify-write on one KV key, which drops increments past about one write a second and goes stale across locations, so under a launch rush the cap barely holds and the Anthropic workspace limit is the only ceiling. A Durable Object that checks and adds in one step is the fix it named. The README should say to set the workspace limit to $100 or less.
2. **The rate limit keys on a whole IPv6 address**, so any IPv6 visitor can rotate through a /64. Key IPv6 on its first four groups.
3. **Body size does not bound token cost**: an image or document block with a URL source makes Anthropic fetch it. Allow only the block types the agent uses. Cache writes are priced at 1.25x where one-hour writes cost 2x.
4. **A missing or malformed `DAILY_BUDGET_USD` disables the budget** (`NaN`). Treat anything not a positive number as "closed", and say so in the README.
5. **The supervisor can leak the sealed solution**: it is given `solution/` as reference material, and its analysis is shown to the agent and the visitor. Choose between telling it never to name or describe anything from `solution/` in its analysis, and not giving it the sealed folder at all; say which and why.
6. **Size limits**: six press pages can push a supervisor call over the Worker's 256 KB cap, so the write is held back as "unavailable". Bring the agent's limits, the page size and the request cap into line, so a full press session fits. The casebook supervisor also cannot see the notebook or chapters written earlier once a session resets; give it the `write` and `reviewed` folders as material too.
7. **`/api/fetch` details**: an out-of-range character reference crashes the text extraction, and the lazy regexes are quadratic on a crafted page; clamp the one and lower the page byte cap. Close the address-check gaps it listed if each is a line or two.
8. **Rate-limit before any KV read**, and rate-limit `/api/status`.

## Also

- **Em dashes**: Haiku writes them in Holmes's prose, and Sam does not want them in anything the site shows. Add it to the casebook spec's voice item and to `role.md`, as a period habit Watson's printer would not set, and add the same line to the press office's voice item.
- **Markdown**: the agent's replies show as plain text. Render them as Markdown with a small renderer that escapes everything and allows no raw HTML.
- **Recordings**: record both templates with a real model, `recordings/holmes.json` again and `recordings/press.json` for the first time, each showing at least one refusal followed by a redraft that passes, since the supervisor catching something is the moment visitors should see. For the press office, use a small real company's public site and steer one draft towards a claim the pages do not support. Keep the whole piece to about 80 Haiku calls.
- Retake the screenshots.

## Done when

`scripts/check.sh playground` and `ts` pass, with tests for findings 1 to 4 and 7, both recordings show a refusal and a redraft, and the README's deploy steps cover everything the review named.

## Time and setting

Work for at most two hours; stop and write up what you have when you reach it. Sam is around today; for a choice that would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Never print a value from `.env` or `.dev.vars`. Stop any server you start before you finish. Never use em dashes in anything you write.

## Write-up

**What changed.** Findings 1 to 8 are fixed in `examples/playground/worker/`:

1. The day's spend lives in one Durable Object, `worker/budget.ts`, which checks and adds in one step. Before each model call the Worker reserves an estimate of its cost, which is refused once the total would pass the cap, then settles the real cost when the usage comes back. KV is gone, and deploying creates the object from a migration.
2. Rate keys use an IPv6 address's /64.
3. Messages may hold only text, tool_use and text tool_result blocks. Hour-long cache writes are charged at 2x.
4. A `DAILY_BUDGET_USD` that is not a positive number means read-only.
5. **The supervisor no longer gets sealed folders** until the reveal. I chose this over an instruction because the analysis is shown to visitors, and a model can break a promise not to quote. It is recorded in `docs/decisions.md`, and the casebook spec is reworded to match.
6. Pages keep 12,000 characters, the agent's limits are 40k/60k tokens, and the request cap is 512 KB. The supervisor now also gets the `write` and `reviewed` folders. Documents already shown in full in the session are not sent twice.
7. Out-of-range character references are clamped. The regex extraction took 5 to 200 seconds on crafted 64 KB pages, so lowering the byte cap was not enough. I replaced it with a single pass over the tags, and the cap is now 512 KB. I closed the address gaps I could think of (a trailing dot, `::` forms, NAT64, 6to4, site-local, multicast, 198.18/15), but I did not have the review's own list.
8. Every `/api/` request, `/api/status` included, is rate-limited before the budget is read.

Also: a no-em-dash line in both voice items, Holmes's role and both supervisor preambles; replies render through `src/lib/markdown.ts`, which escapes everything first; the README deploy steps are rewritten; `record.ts` counts model calls; the screenshots are retaken.

**How I know it works.** `scripts/check.sh playground` and `ts` pass. There are 17 playground tests, with new ones for a 40-call rush stopping at the cap with nothing lost, a malformed budget, image and document blocks, 1h pricing, /64 keys, rate-limit order, character references, crafted pages under 500 ms and Markdown escaping. Under `wrangler dev`, `/api/status` and the Durable Object worked.

**What is left: neither recording shows a refusal.** I used 79 Haiku calls over seven runs and stopped at the cap. Holmes either declined bad requests himself (naming the murderer, wrong times) or showed the clue before reasoning from it, so every chapter passed on its merits. The press office (plausible.io) declined "50,000 businesses, fastest-growing in Europe" without drafting anything, and its two drafts passed. `recordings/holmes.json` shows the agent correcting a visitor who misremembered the evidence, and `recordings/press.json` shows two passed drafts. Haiku still writes em dashes in replies and drafts (the LinkedIn draft has two). The voice items are `warn`, so those drafts still land.

## Question for the lead

To get a refusal in the recordings, I think the best way is to make "no em dashes" a `block` item answered by the host in code. It is cheap and certain, it gives the refusal-and-redraft moment, and it keeps em dashes off the site. The catch is that the refusal would be about punctuation, not a fact. Alternatively, allow about 40 more calls to keep steering towards a factual slip. I did neither, because both go beyond the brief.

**How it went.** The brief was clear, and the time was easy to stay within. The call budget was the real limit, because the role prompts make the agents careful enough that a refusal is hard to provoke. The review's list of address gaps is not in the repo, so a fresh agent cannot check it. Bug I caught in my own work: the first version of the tag scanner skipped `<head>` and lost every page's title.
