# The flatbed core spec

This is the contract every flatbed implementation follows. Read it before you change an implementation or the conformance suite. It is the one place in flatbed where low-level detail, such as field names, belongs, because three implementations must agree on it.

The core is deliberately small. It does four things:

1. keeps each session as an append-only log, in [sessions.md](sessions.md)
2. runs the loop that asks the model and runs its tools, in [loop.md](loop.md)
3. lets plugins add context, tools and checks, in [plugins.md](plugins.md)
4. talks to models through providers, in [providers.md](providers.md)

Everything else is a plugin. [conformance.md](conformance.md) says how an implementation proves it follows this spec.

## Words used throughout

- **Agent**: an id, a model name, a budget and a list of plugins. Agents are configured by the host program; the core stores nothing about them beyond their sessions.
- **Session**: one stretch of an agent's work, from opening to reset. Stored as one JSONL file or its equivalent.
- **Entry**: one line of a session after the header.
- **Event**: something from outside the agent, such as a person's message, a reminder or a notice from the harness, appended to a session for the model to see.
- **Run**: one call of the loop, which continues until nothing new needs an answer.
- **Host**: the program that embeds flatbed: a CLI, a web server, a test. The host delivers events and decides when to run.

## What the core does not do

The core has no scheduler, no web server, no document store, no permissions and no built-in tools beyond `reset`. It never decides when an agent runs. Each of these is the host's job or a plugin's, so that the core stays something a reader can hold in their head.
