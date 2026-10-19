# Kickoff: the playground as one press office demo

Sam has narrowed the playground to the press office alone. A visitor pastes their company's website and, in two to five minutes, sees an agent do knowledge work in three steps: take in the company's public pages, organise them into well-written documents (a fact sheet with a source for every fact, a voice guide, the people and products), and produce work from them (an announcement or post in the company's voice) that a supervisor checks against the pages. Afterwards they can look at how it was done: the folders and their permissions, each document's history, and every session as the model saw it. The Holmes template is out, because a made-up case asks people to care about invented people before they see anything useful. Read `AGENTS.md`, `docs/playground.md`, `examples/playground/` and its README, and `examples/playground/templates/press/`, and then this brief. When you are done, add your write-up at the bottom of this file.

## What the visitor experiences

1. One page with one box: paste your company's website. No template picker.
2. The three steps, shown as they happen and labelled as such: **reading** (each page appears in `sources/` as it is fetched, about six), **organising** (the fact sheet fills in, each fact linked to its page, then the voice guide and the people and products), **writing** (a first short piece lands without the visitor typing anything, with the supervisor's check beside it).
3. Then it is theirs: three or four one-click asks, such as a reply to a journalist, a launch post, or what is missing from the site, and open chat. Any claim the pages do not back is caught and redrafted where they can see it.
4. A clear way into "how this works": the folders and their modes, document history, sessions as the model saw them, download.

## Guidance

- **Remove Holmes** from the playground: its template folder, its recording, and references in the app, README and docs. The folder modes stay in `@flatbed/docs`; the press office uses read, write and reviewed.
- **Rework `docs/playground.md`** to describe the playground as it now is, and add a decision entry for narrowing to the press office, with Sam's reason.
- **The three steps** are what the agent already does; what changes is that the app shows them as the main view, and that the agent goes on to write a first piece after organising. Getting there may mean tightening `role.md` and the opening, so that a run reaches its first draft in a couple of minutes on Haiku.
- **One recorded example** on a small real company's public site, shipped for when the day's budget is spent, showing all three steps.
- Keep what the review hardened: the Worker's guards, the sealed-free supervisor material, the size limits.
- The em-dash line stays guidance only; no hard rule.

## Done when

`scripts/check.sh ts playground` passes; a live run under `wrangler dev` goes from a pasted address to a checked first draft without the visitor typing anything more; the recording is in place; and the screenshots, light and dark, desktop and phone, show the three steps.

## Time and setting

Work for at most two hours; stop and write up what you have when you reach it. Sam is around; for a choice that would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Keep live model calls to about 40. Never print a value from `.env` or `.dev.vars`. Stop any server you start before you finish. Never use em dashes in anything you write.

## Write-up
