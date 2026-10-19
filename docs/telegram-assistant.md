# The Telegram assistant

A personal agent, built on flatbed, that Sam talks to on Telegram. The aim is something as close to Instinct as possible, built very small and made to work very well. Sam asked for it on 19 October 2026. It sits in `examples/telegram-assistant/` while it takes shape, and may become its own template repo later.

## What it is like to use

You message the agent on Telegram, and it answers and acts. It remembers you through documents it keeps. It can set itself reminders, one-off or recurring, and comes back to you when they fire. It can send email on your behalf, and every send is checked against a brief the agent keeps and you control. You can ask what it has spent, and it stays inside a monthly budget you set.

## How it runs

One Cloudflare Worker receives Telegram's webhook and accepts messages only from Sam's chat. One Durable Object holds everything the agent has: its sessions, its documents, its reminders and its spend. It implements flatbed's session store and the docs plugin's store on Durable Object storage, and a Durable Object alarm wakes the agent for reminders. The agent is flatbed's TypeScript core on the Anthropic provider, with the model set in its configuration and changeable by the agent.

## The toolbelt

The agent's tools come in groups, each with a name, a line on what it is for, and its tools, shaped like an MCP server so a group could later be served as one, and an MCP server could join as a group. They live in a reusable package, `@flatbed/toolbelt`.

- **memory**: the docs plugin's tools, always connected
- **toolbelt**: `reveal_tools`, `hide_tools` and `set_model`, always connected
- **reminders**: set, list and cancel reminders, one-off at a time or recurring by cron expression, each with a note to the agent's future self
- **briefs**: read and write the supervisor briefs that guard actions
- **spend**: today's and this month's spend against the limits
- **email**: `send_email` through Resend, guarded by `briefs/send_email`

Later groups, such as Gmail, Calendar, web browsing and a sandbox for making files, join the same way.

**Connecting a group.** The agent's context lists every group with its one line, and says which are connected. `reveal_tools` adds groups to the agent's list for its next session; the agent then writes down where it is in its notes and calls `reset`, and the next session opens with those tools' real definitions. `hide_tools` takes groups off the list. This keeps each session's context fixed, so caching holds and the log is true to what the model saw, and it needs no change to the core.

## Briefs, and the brief over briefs

A brief is a supervisor spec for one action, kept as a document in `briefs/`, such as `briefs/send_email`. The guard reads the current brief at each call, so a change takes effect at once.

The agent's documents sit in folders with modes from the docs plugin:

- `rules/` (read): the agent's soul and the meta-brief. Only Sam changes these.
- `briefs/` (reviewed): the briefs. Every write is checked against the meta-brief.
- `me/` and `notes/` (write): what the agent knows about Sam and its working notes, with the timeline.

The meta-brief allows any change that makes a brief stricter. A change that loosens a brief, or removes one, passes only when Sam asked for it in his own Telegram message in the session, since text the agent has read, such as an email, could otherwise talk it out of its own checks.

## Spend

The host prices each model call from its recorded usage and a price table, and keeps a running total per day and per month. Sam sets a monthly limit; the daily limit is a tenth of it. The host checks before each run, and after each model call through the core's `onEntry` hook, stopping a run cleanly with a note in the session when a limit is reached. The agent's context carries one line on spend so far, so it can choose a cheaper model when money is short.

## Commands

The Telegram chat is the whole interface. A few commands answer without the model: `/usage`, `/docs`, `/briefs`, `/reminders` and `/model`.

## Setup

The repo's README is written for Claude Code to follow, stopping where Sam has to act: logging in to Cloudflare, making a Telegram bot with BotFather, and giving his Anthropic and Resend keys. Everything else, the deploy, the secrets and registering the webhook, Claude Code does.

## Left for later

Gmail and Calendar, web browsing through Cloudflare's Browser Rendering, a sandbox with persistent files for making documents and PDFs, computer use, codemode, WhatsApp, and more than one user.
