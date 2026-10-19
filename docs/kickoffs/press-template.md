# Kickoff: the press office template

You are writing the playground's second template: a press office for any company. The visitor pastes a company's web address; the agent reads its public pages, builds a fact sheet and a voice guide, then drafts announcements, replies to journalists and posts, each checked by a supervisor before it lands in the outbox. It is mostly content, plus the contract for one tool. Read `AGENTS.md`, `docs/playground.md` (its press office section sets the folders), `docs/kickoffs/_template-format.md`, `ts/packages/supervisor/README.md` and `spec.schema.json`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Guidance

- **The moment to aim for:** a draft refused because a claim, such as "trusted by 10,000 teams", appears on no page the agent read, with the supervisor saying so plainly. The outbox spec is the heart of the template: every factual claim traceable to a page in `sources/`, no invented numbers, customers, awards or quotes, quotes only from people named on the site and otherwise a placeholder, no promises about the future, the tone matching the voice guide, and the line marking it an unofficial draft made in a demo. Write its preamble so the supervisor understands why a press office cares.
- **`role.md`** describes the work of a careful press officer and what has worked: read a handful of pages first (the home page, about, product, blog or news), write the fact sheet with the page behind each fact, write the voice guide from how the company writes, then draft. It should keep the page budget in mind: about six pages per company.
- **The `fetch_page` tool's contract**, written into the template's folder as `fetch_page.md` for the app builder: its input, what it returns to the agent, how it saves into `sources/` (name, summary, body), and what it says when a page cannot be fetched. Keep a page's saved text to about 8,000 tokens.
- **`ask`** asks for the company's web address before the agent starts.
- **Prompts** a visitor clicks after the fact sheet exists, such as a launch announcement, a reply to a journalist asking about a rumour, and a LinkedIn post.
- **The look:** a clean newsroom, in the token format given.
- Test the spec on paper: write two short drafts, one that should pass and one that should be refused, against an invented company's sources, and check the spec's wording would catch the second. Keep them in the write-up, not the template.

## Done when

The template folder is complete in `examples/playground/templates/press/`, valid against the format and the supervisor schema, with `fetch_page.md` clear enough to build from.

## Time and setting

Work for at most 60 minutes; stop and write up what you have when you reach it. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Never use em dashes in anything you write.

## Write-up

### What changed

The press office template is in `examples/playground/templates/press/`: `template.json`, `role.md`, `specs/outbox.json`, `fetch_page.md` and `look.css`. There are no seed documents, because the fact sheet and voice guide come from the company's pages, and a skeleton could be mistaken for facts.

- **The outbox spec** has six items, facts first: the demo line, numbers and names, other claims, quotes, promises, and tone (`warn`). The preamble casts the supervisor as the press office's fact-checker and says the agent's own notes are not evidence.
- **`role.md`** sets the order: read about six pages, picking each from the links the last one returned; write and pin `notes/fact-sheet` and `notes/voice-guide`; then draft. Before drafting, the agent re-reads the pages behind its claims, because a one-call supervisor sees only the session.
- **`fetch_page.md`** sets the input, the naming scheme (`sources/quillfern-example-about-us`), the summary, a body headed by `Source:` and `Fetched:` lines and cut at 32,000 characters, a result that carries the saved text in full plus up to 30 links, and a table of failure results.

### Choices someone could make differently

- Quotes: I read "quotes only from people named on the site" strictly. A quote must be words a page gives that person, or else a placeholder that names them. Drafting new words for a real CEO, even for approval, felt too risky for a public demo.
- The demo line is checked by the model, not the host, so the app needs no code for this template.
- `fetch_page` returns the full text, not a summary, so the supervisor can check against it. This makes sessions bigger.
- I changed the first prompt from "as if it had just launched" to a plain press release. The old wording asked the agent to claim something no page says.

### How I know it works

The spec passes `parseSpec`, and `template.json` has the format's keys and modes (scratch script, not committed). `scripts/check.sh ts` printed "all checks passed".

On paper, with invented sources for Tidewell. `sources/tidewell-example-home` says: "Refillable cleaning tablets for small cafes, shipped in paper. Used by over 300 cafes in Bristol and Bath." `sources/tidewell-example-about` says: "Founded in 2021 by Maya Okonjo (CEO) and Ravi Teller (head of product). 'We started Tidewell because our own cafe threw away forty plastic bottles a week,' says Maya."

Should pass:

> Tidewell makes refillable cleaning tablets for small cafes, shipped in paper rather than plastic, and over 300 cafes in Bristol and Bath use them. "We started Tidewell because our own cafe threw away forty plastic bottles a week," says Maya Okonjo, CEO. [Quote from Ravi Teller, head of product, to be supplied]
> _Unofficial draft written by an AI agent in the flatbed playground demo. Not from or approved by Tidewell._

Every number, place and name is on a page. The quote is word for word, and the placeholder names a person the site names.

Should be refused:

> Tidewell, trusted by 10,000 teams across the UK, today unveils its tablets. "Our tablets are the future of cleaning," says Maya Okonjo. London cafes get them next spring.

The spec refuses it on five items. Under `numbers_and_names_on_a_page`, "10,000 teams" and "the UK" are on no page (its example names that exact case). Under `claims_on_a_page`, "across the UK" goes further than Bristol and Bath. Under `quotes_are_real_or_placeholders`, the quote is new words given to a named person. Under `no_promises`, no page makes the London promise. Under `marked_unofficial`, the line is missing.

### What is left

- No live run yet: the app is not built. Run it in `shadow` mode first to check that true claims from pages outside the session are not refused too often.
- Edits: with `edit_doc`, the supervisor sees only the changed passage. The spec judges that passage alone. The guard could show the whole document after the edit.
- If refusals for unseen pages are common, `agentPass` with a read-only `read_doc` would let the supervisor look pages up itself.

### How it went

The format brief and the supervisor README made this fast. The spec's `lookFor` advice, to say which cases pass, did the most to shape it. Two things were not in any doc, and I had to work them out from `ts/packages/docs`. First, that a one-call supervisor sees only the current session, so sources fetched in an earlier session are invisible to it. Second, which fields `write_doc` and `edit_doc` take. `docs/playground.md` could say that a reviewed folder's spec judges a single call, not the finished document.
