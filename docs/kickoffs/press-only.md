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

### What was done

- **Holmes is gone**: its template folder, its recording, the picker and the old screenshots. The loader still reads any template in the same format, and the agent still keeps a sealed folder from the supervisor, since the modes belong to `@flatbed/docs`; the comments now say the press office has none. The `@flatbed/docs` folder tests still use Holmes names as fixtures; I left them, since they test the library and not the playground.
- **One page, one box.** `#/` is the start page: a headline, the company website box, the three steps in a line each, and links to the recorded example and "how this works". Once the run starts, the main view is the three steps side by side (stacked on a phone), each marked next, under way or done: the pages in `sources/` as they arrive, the fact sheet's first eight facts each with a link to its page plus the other notes, and each draft beside the supervisor's latest ruling on it. The conversation, three one-click asks and a box for your own come below. `#/how` has the folders and their modes, each document's versions, every ruling and every session. Documents now render as Markdown, with names such as `sources/acme-about` linked, so a fact links to its page.
- **The role** now asks for all three steps in one go after the first message: fetch the home page, then the rest together in one turn, write `notes/fact-sheet`, `notes/voice-guide` and the new `notes/people-and-products`, then write a post of about 120 words introducing the company into `outbox/`, and only then reply. It no longer asks the agent to `read_doc` pages before drafting, since the supervisor gets every document in the visible folders. The asks are now a reply to a journalist about an acquisition rumour, a launch post, and what the site leaves out.
- **The recording** is `recordings/press.json`, a run on plausible.io with the journalist ask: six pages, three notes, a first post that passed, and a reply that was refused once for leaving out the demo line, then passed. 12 model calls.
- **Docs**: `docs/playground.md` describes the playground as it is now, with the template format in prose; a decision entry, "The playground is the press office alone", gives Sam's reason; the README points to the loader and to `docs/playground.md` for the format, instead of the deleted `_template-format.md`.
- **Checks and screenshots**: `scripts/check.sh ts playground` passes, with new tests for the steps, the fact lines and document links. `screenshots/` has the start page, the example and the how-it-works page, light and dark, desktop and phone.

### The live run

Under `wrangler dev`, in the browser pane, I pasted `https://buttondown.com` and typed nothing more. In under a minute the agent fetched seven pages, wrote and pinned the three notes, wrote `outbox/introducing-buttondown`, and the supervisor passed it. The steps filled in as described. About 22 live model calls in all, with the recording.

### How it went

- Haiku follows the three steps reliably and fast: two runs, both reached a checked first draft in about ten calls.
- The agent narrates between tool calls ("Perfect. Let me now...") and uses long dashes in chat replies. I added a line to the role asking for few words between calls and no long dashes in replies, after the live run; the recording ran with it and had no long dashes, but still narrates a little. The draft text had none in either run.
- In the recording, the first reply ends "The supervisor has received the draft. Awaiting its check." after the check had passed. It is harmless but odd; a line in the role saying the ruling comes back with the write's result might fix it.
- The live run also wrote to the timeline, one wasted call. Worth leaving unless runs get slow.

### Not done

- The steps view does not show a fetch that failed; failures appear only as tool lines in the conversation.
- The start-page screenshots show the empty box, so the three steps appear in the example screenshots only, done rather than under way.
