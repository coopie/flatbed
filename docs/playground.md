# The playground

The playground is a public page where anyone can watch a flatbed agent do knowledge work, in a few minutes, with no sign-in. A visitor pastes their company's website, and the agent works as that company's press office in three steps: it reads the public pages, organises them into well-written documents, and writes from them, with a supervisor checking each draft against the pages. Afterwards the visitor can see how it was done: the folders and their permissions, each document's history, and every session as the model saw it. Sam agreed the shape on 19 October 2026, for a launch paid for with about $100 of Anthropic credit, and narrowed it to the press office alone the same day.

## Who it is for and what it shows

People who have heard about agents and want to see one do useful work on something they know. Their own company is the thing they know best, so they can judge the result at once. The run shows three things flatbed is built around: documents the agent keeps as its memory, folders with different permissions, and a supervisor that checks the agent's work before it lands.

## What the visitor sees

1. One page with one box: the company's website. There is no template to choose.
2. The three steps, as they happen, as the main view:
   - **Reading**: each page appears in `sources/` as it is fetched, about six.
   - **Organising**: the fact sheet fills in, each fact beside a link to its page, then the voice guide and the people and products, in `notes/`.
   - **Writing**: a first short post introducing the company lands in `outbox/` without the visitor typing anything more, with the supervisor's ruling beside it.
3. Then it is theirs: three one-click asks (a reply to a journalist about a rumour, a launch post, what the site leaves out) and open chat. A claim the pages do not back is refused and redrafted in view.
4. "How this works": the folders and their modes, each document's history, every supervisor ruling, each session as the model saw it, and a download.

A run on Haiku 4.5 reaches its first checked draft in about a minute and in about ten model calls, the supervisor's included.

## How it works

**Everything lives in the visitor's browser.** The agent's loop is flatbed's TypeScript core, running in the page. Sessions and documents are kept in the browser's IndexedDB, through a session store and a document store written for it. Nothing about a project is kept on a server, so there is no state to manage, and a project lasts as long as the visitor's browser keeps it. A visitor can download a project as a folder of Markdown files, or reset it.

**A small stateless server does two jobs**, as a Cloudflare Worker that also serves the static site:

- `/api/complete` passes a model call to Anthropic with Sam's key, and holds the guards on spending: the model is always Claude Haiku 4.5, requests and responses are capped in size, each IP address has a rate limit (Cloudflare's rate-limit binding), and a daily spend counter (one Durable Object, which checks the budget and adds to it in one step) switches the playground to read-only once the day's budget is gone. The Anthropic key also sits in its own console workspace with a spending limit of $100 or less, as a backstop.
- `/api/fetch` fetches one public web page for the press office, as text: http and https only, public addresses only, a size cap, and a short cache.

Since the browser assembles the prompt, someone could use the proxy as free Haiku within those limits. The daily cap bounds that, which is acceptable for a short demo.

**The supervisor runs in the page too**, through `@flatbed/supervisor`'s guard, calling the model through the same proxy.

## Folders and their permissions

The agent's folders each have a mode. The modes are a general addition to `@flatbed/docs`, useful to any agent and not only the playground:

- **read**: the agent can list and read; nothing writes here except the template or the host, such as fetched pages
- **write**: the agent can read and write freely
- **reviewed**: the agent can read; a write runs past a supervisor spec first, and lands only if the spec passes
- **sealed**: hidden from the agent's listing and reading until the host unseals it. The playground's agent keeps it from the supervisor too, since a supervisor's analysis is shown to the agent and the visitor. The press office does not use it

## The template

The press office is a template folder, `examples/playground/templates/press/`, in a format the app's loader ([src/lib/template.ts](../examples/playground/src/lib/template.ts)) reads:

- `template.json`: name, pitch, folders and their modes, the supervisor spec for each reviewed folder, the opening message, the one-click asks, the question the start box asks, and the app's tools it uses
- `role.md`: the agent's role, pinned first in its context
- `specs/`: the supervisor spec for each reviewed folder
- `look.css`: the colour and type tokens, inside the frame `docs/design.md` sets
- `seed/`, when there is one: starting documents, by folder

Its folders:

- `sources/` (read): the fetched pages, written only by the fetch tool
- `notes/` (write): the fact sheet, with the page behind each fact, the voice guide, and the people and products
- `outbox/` (reviewed): drafts for publication; the supervisor refuses any claim not found on a page, invented numbers, customers or awards, quotes from anyone not named on the site, and promises about the future, and checks the tone against the voice guide

Every draft carries a line marking it as an unofficial draft made in a demo. The role asks for no long dashes in drafts and replies, and the supervisor's tone check fails a draft that has one; it is guidance, not a hard rule on the model's output.

The loader still reads any template in this format, and the agent still keeps a sealed folder from the supervisor, since the modes are `@flatbed/docs`'s and another host may use them. The playground ships only the press office.

## The look

The frame follows `docs/design.md`, the aiding.agency look. The press office brings its own tokens inside that frame, a clean newsroom look.

## After the launch

When the day's budget is spent, the playground stays up in read-only mode. A recorded example, a real run on a small company's public site (plausible.io) made once and shipped with the site, shows all three steps and a refused draft, so visitors can browse the documents, rulings and sessions without spending anything. The page links to the flatbed repo.

## What it leaves out

Accounts, shared or multiplayer projects, and any server-side storage of projects.
