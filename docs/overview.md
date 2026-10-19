# Overview

flatbed is a very small agent harness, and a worked example of building a real agent on it. The core runs a model in a loop and keeps each session as an append-only log. Plugins add everything else. The example on top is a personal assistant: a small web app where an agent keeps its own documents, reads your mail and calendar, and proposes what to send for you to approve.

## Why

Most agent frameworks are large, and the shape of a good agent gets lost inside them. Sam has built the same harness several times, for Otherworldly, a Slack agent and perso, and the parts that mattered were few: an append-only session log, a loop that survives crashes, a reset when the context fills, documents the agent maintains in place of a system prompt, and a supervisor that checks risky actions. flatbed writes those parts down once, as a spec small enough to implement in an afternoon, with three reference implementations to prove it.

flatbed succeeds if a reader can understand the whole core in one sitting, and then see, layer by layer, how a working product is built on it.

## How it works

**The core.** An agent is an id, a model and a list of plugins. A session is one JSONL file: a header, then entries, each with an id and its parent's id. Entries hold the frozen context (named sections and tool definitions), the messages to and from the model in flatbed's own format, events from the outside world, and resets. The loop runs while something new needs an answer: it renders the session into messages, asks the model, runs the tools it called, and appends everything. When the session grows past its budget, the agent is told to bring its notes up to date and reset, and the next session starts fresh. `reset` is the only tool the core provides. [docs/spec/](spec/README.md) is the full contract.

**Plugins.** A plugin is a plain object with up to five hooks: adding context sections and tools when a session opens, checking a tool call before it runs, seeing a tool's result, seeing every entry, and seeing a session end. Plugins are how the core stays small.

**Providers.** A provider turns flatbed's messages into one API's format and back. Each implementation has a scripted fake provider for tests, an Anthropic one and an OpenAI-compatible one.

**Plugins and libraries, in `ts/packages/`:**

- `docs`: a versioned document store, documents pinned to an agent as context sections, the agent's daily timeline pinned last, and tools to read and write them
- `supervisor`: a spec format for a supervisor (task, preamble, checklist), the verdict schema derived from it, a runner that checks a session in one model call or with an agent, and a plugin that applies verdicts to tool calls
- `mcp`: tools served by MCP servers, which is how a tool written in any language joins an agent
- `dispatch`: sub-agents, as child sessions that report back

**The example**, in `examples/assistant/`: a SvelteKit app for two to four people, on Postgres, ready for Cloud Run. It has chat, the agent's documents with their history, past sessions as the model saw them, the timeline, and proposals: what the agent would like to send by email or put in the calendar, and why, for a person to accept, edit or deny.

## When you add to it

The session log is the one record of what an agent did. The supervisor reads it to check a session, and the example app reads it to show each session as the model saw it, so nothing needs a second account that could disagree with it. Behaviour that every agent needs belongs in the core and its spec. Everything else has fitted as a plugin so far, which keeps the core small enough to read in one sitting. The three implementations stay in step through the spec and the conformance suite, as [ways of working](ways-of-working/README.md) describes.

## Where we are

A lightly held plan, started on 6 October 2026 and last rewritten on 18 October.

**Done**

- The docs and the spec, with the docs brought in line with Sam's updated starter docs on 18 October.
- The core in TypeScript, Python and Rust, aligned on 18 October to one async host API ([spec/host.md](spec/host.md)). Each passes the same 49 conformance scenarios and has the fake, Anthropic and OpenAI-compatible providers and a rough CLI. Each runs a turn's tool calls together or one at a time, by the agent's `toolExecution`, and gives tools `ctx.runTool` to run other calls under the same limit, and `ctx.addTools` to add a plugin's `available` tools to the session until it resets, from 19 October. All three have passed the live check against Anthropic.
- The docs plugin: documents pinned as context, and the timeline.
- The supervisor: the spec format, one-call and agent runners, and the guard plugin.
- The MCP plugin, with a Python MCP server as the example, and the dispatch plugin for sub-agents.
- Codemode in all three languages, on one shared Monty worker process, reviewed and fixed: [codemode.md](codemode.md).
- The example app in `examples/assistant`, in demo mode, reviewed and fixed. Google mode and the Docker image are untested.
- An interactive walkthrough from the first night, [walkthrough.html](walkthrough.html).

**Now**

- Nothing is running. The repo is on GitHub at `coopie/flatbed` from 18 October.

**Next**

- A real model through the example app, once the Supabase project is restored.
- Sam's calls on messaging, a Google web client and deploying to Cloud Run, and on the entries in [decisions.md](decisions.md) still marked *for review*.
- Sam's call on which tools a codemode script may call, in [codemode.md](codemode.md).
- A `signal` on `ctx.runTool`, so a slow nested call cannot hold a script past its deadline, if that starts to matter.
- A `callId` on the tool context, so the app need not match a proposal to its call by input.

**Built on flatbed elsewhere**

- [Parker](https://github.com/coopie/parker), a personal agent Sam talks to on Telegram, from 19 October 2026. It depends on flatbed's core, docs plugin and supervisor, and grows a toolbelt of tool groups that may come back here once a second agent needs it.

**Later, if it earns its place**

- Messages to and from the assistant over WhatsApp or iMessage.
- Finding tools progressively, a sandbox for files and code, and computer use.
