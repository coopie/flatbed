# Overview

flatbed is a very small agent harness, and a worked example of building a real agent on it. The core runs a model in a loop and keeps each session as an append-only log. Plugins add everything else. The example on top is a personal assistant: a small web app where an agent keeps its own documents, reads your mail and calendar, and proposes what to send for you to approve.

## Why

Most agent frameworks are large, and the shape of a good agent gets lost inside them. Sam has built the same harness several times, for Otherworldly, a Slack agent and perso, and the parts that mattered were few: an append-only session log, a loop that survives crashes, a reset when the context fills, documents the agent maintains in place of a system prompt, and a supervisor that checks risky actions. flatbed writes those parts down once, as a spec small enough to implement in an afternoon, with three reference implementations to prove it.

flatbed succeeds if a reader can understand the whole core in one sitting, and then see, layer by layer, how a working product is built on it.

## How it works

**The core.** An agent is an id, a model and a list of plugins. A session is one JSONL file: a header, then entries, each with an id and its parent's id. Entries hold the frozen context (named sections and tool definitions), the messages to and from the model in flatbed's own format, events from the outside world, and resets. The loop runs while something new needs an answer: it renders the session into messages, asks the model, runs the tools it called, and appends everything. When the session grows past its budget, the agent is told to bring its notes up to date and reset, and the next session starts fresh. `reset` is the only tool the core provides. [docs/spec/](spec/README.md) is the full contract.

**Plugins.** A plugin is a plain object with up to five hooks: adding context sections and tools when a session opens, checking a tool call before it runs, seeing a tool's result, seeing every entry, and seeing a session end. Plugins are how the core stays small.

**Providers.** A provider turns flatbed's messages into one API's format and back. Each implementation has a scripted fake provider for tests and an Anthropic one; TypeScript also has an OpenAI-compatible one.

**Plugins and libraries, in `ts/packages/`:**

- `docs`: a versioned document store, documents pinned to an agent as context sections, the agent's daily timeline pinned last, and tools to read and write them
- `supervisor`: a spec format for a supervisor (task, preamble, checklist), the verdict schema derived from it, a runner that checks a session in one model call or with an agent, and a plugin that applies verdicts to tool calls
- `mcp`: tools served by MCP servers, which is how a tool written in any language joins an agent
- `dispatch`: sub-agents, as child sessions that report back

**The example**, in `examples/assistant/`: a SvelteKit app for two to four people, on Postgres, ready for Cloud Run. It has chat, the agent's documents with their history, past sessions as the model saw them, the timeline, and proposals: what the agent would like to send by email or put in the calendar, and why, for a person to accept, edit or deny.

## When you add to it

Keep the session log as the one record: anything that wants to know what happened reads it. Add behaviour as a plugin unless every agent needs it. Keep the three implementations in step through the spec and the conformance suite.

## Where we are

A lightly held plan, started on 6 October 2026.

**Done**

- The docs and the spec.

**Now**

- The core in TypeScript, with the conformance suite and the fake provider.
- The supervisor library.

**Next**

- The docs, MCP and dispatch plugins.
- The Python and Rust implementations, against the suite.
- The example app, with Google mail and calendar and the proposal screen.
- A walkthrough of the whole stack, from the core to the app.

**Later, if it earns its place**

- Codemode: the model writes a short script that calls several tools at once. See [codemode.md](codemode.md). Sam wants to look at the design first.
- Messages to and from the assistant over WhatsApp or iMessage.
- Finding tools progressively, a sandbox for files and code, and computer use.
