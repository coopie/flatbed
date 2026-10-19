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
