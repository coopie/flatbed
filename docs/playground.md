# The playground

The playground is a public page where anyone can try a flatbed agent doing knowledge work, in a few minutes, with no sign-in. A visitor picks a template, works with the agent, and sees what it built: the documents in its folders, the supervisor's rulings, and each session as the model saw it. Sam agreed the shape on 19 October 2026, for a launch paid for with about $100 of Anthropic credit.

## Who it is for and what it shows

People who have heard about agents and want to see one work. Each template shows three things flatbed is built around: documents the agent keeps as its memory, folders with different permissions, and a supervisor that checks the agent's work before it lands.

## How it works

**Everything lives in the visitor's browser.** The agent's loop is flatbed's TypeScript core, running in the page. Sessions and documents are kept in the browser's IndexedDB, through a session store and a document store written for it. Nothing about a project is kept on a server, so there is no state to manage, and a project lasts as long as the visitor's browser keeps it. A visitor can download a project as a folder of Markdown files, or reset it.

**A small stateless server does two jobs**, as a Cloudflare Worker that also serves the static site:

- `/api/complete` passes a model call to Anthropic with Sam's key, and holds the guards on spending: the model is always Claude Haiku 4.5, requests and responses are capped in size, each IP address has a rate limit (Cloudflare's rate-limit binding), and a daily spend counter (one Durable Object, which checks the budget and adds to it in one step) switches the playground to read-only once the day's budget is gone. The Anthropic key also sits in its own console workspace with a spending limit of $100 or less, as a backstop.
- `/api/fetch` fetches one public web page for the press office template, as text: http and https only, public addresses only, a size cap, and a short cache.

Since the browser assembles the prompt, someone could use the proxy as free Haiku within those limits. The daily cap bounds that, which is acceptable for a short demo.

**The supervisor runs in the page too**, through `@flatbed/supervisor`'s guard, calling the model through the same proxy.

## Folders and their permissions

A template gives its agent folders, each with a mode. The modes are a general addition to `@flatbed/docs`, useful to any agent and not only the playground:

- **read**: the agent can list and read; nothing writes here except the template or the host, such as fetched pages
- **write**: the agent can read and write freely
- **reviewed**: the agent can read; a write runs past a supervisor spec first, and lands only if the spec passes
- **sealed**: hidden from the agent's listing and reading until the host unseals it. The playground keeps it from the supervisor too, since a supervisor's analysis is shown to the agent and the visitor

## A template

A template is a folder in the playground holding:

- `template.json`: name, one-line pitch, folders and their modes, the supervisor spec for each reviewed folder, the opening message, three clickable prompts, and its look
- `seed/`: the starting documents, by folder
- `look.css`: the template's colour and type tokens, used on its card in the picker and throughout its project

## The templates

**A lost Holmes case, half told.** An original case in Doyle's manner, about half finished: the scene, the client, the suspects, the evidence and Holmes's early deductions are written, and the solution is sealed. The visitor helps Holmes finish it.

- `evidence/` (read): the physical facts of the case
- `yard/` (read): Lestrade's official file, confident and partly wrong
- `holmes/` (write): Holmes's private notebook of suspicions and deductions
- `casebook/` (reviewed): Watson's account, which readers see; the supervisor refuses unproven suspicions, spoilers and clues the reader has not been shown
- `solution/` (sealed): what really happened, unsealed when the visitor asks for the reveal

**The press office for a company.** The visitor pastes a company's web address. The agent reads its public pages through `/api/fetch` and builds a fact sheet and a voice guide, then drafts announcements, replies to journalists and posts.

- `sources/` (read): the fetched pages, written only by the fetch tool
- `notes/` (write): the fact sheet, with the page behind each fact, and the voice guide
- `outbox/` (reviewed): drafts for publication; the supervisor refuses any claim not found on a page it read, invented numbers, customers or awards, quotes from anyone not named on the site, and promises about the future, and checks the tone against the voice guide

Every draft carries a line marking it as an unofficial draft made in a demo.

A third template, a world bible guarded by a continuity editor, waits until there is a world to build on that is familiar without having been written about at length.

## The look

The frame follows `docs/design.md`, the aiding.agency look. Each template brings its own tokens inside that frame: Holmes in a Baker Street casebook look, the press office in a clean newsroom look. The picker shows each template's card in its own look.

## After the launch

When the day's budget is spent, the playground stays up in read-only mode. Each template has a recorded example project, made once with a real model and shipped with the site, so visitors can browse the documents, rulings and sessions without spending anything. The page links to the flatbed repo.

## What it leaves out

Accounts, shared or multiplayer projects, and any server-side storage of projects.
