# The host API

This page is the surface a host programs against: how it configures an agent, hands it events, runs it and stops it. Every implementation offers the same surface with the same words, spelled in its language's style: `maxConcurrentTools` in TypeScript is `max_concurrent_tools` in Python and Rust.

## Async throughout

Every implementation is asynchronous from end to end: TypeScript on promises, Python on `asyncio`, Rust on `tokio`. Runs, providers, stores, plugin hooks and tools are all async, so that a model call, a slow tool and a store write never block each other, and a stop can reach any of them.

## Configuring an agent

An agent's configuration holds:

- `id`: the agent's id, which names its sessions in the store
- `model`: `<provider>/<model-name>`, such as `anthropic/claude-opus-5-5`
- `plugins`: in order
- `softLimit` and `hardLimit`: the budget, 120,000 and 180,000 tokens unless set
- `maxTokens`: the most the model may write in one response, 8,192 unless set
- `effort`: optional, passed to providers that take it
- `toolExecution`: `concurrent` or `serial`, `concurrent` unless set, as [loop.md](loop.md) describes
- `maxConcurrentTools`: the most calls that run at once when concurrent, 4 unless set, at least 1
- `parent`: optional, written into the header of the agent's first session only

## The calls

- **`createAgent(config, {store, providers})`** makes an agent. It fails at once, before anything is stored, when the model's provider is not in `providers`, `maxConcurrentTools` is below 1, or `toolExecution` is neither `concurrent` nor `serial`. In Python and Rust the type is `Agent` and the constructor is the language's own, such as `Agent(config, store=..., providers=...)`; its configuration type is `AgentConfig` in all three.
- **`deliver(event, {parentId})`** queues an event for the next delivery point. `parentId` is optional, for a rewind, as [sessions.md](sessions.md) describes.
- **`run({stop})`** runs the loop and returns why it ended: `idle`, `reset`, `stopped` or `error`. It fails, with nothing written, when two tools in the session would share a name, as [plugins.md](plugins.md) describes.
- **A stop** is a value the host makes before a run and sets, with who stopped it, at any time from any task or thread: an `AbortController` in TypeScript, and a `StopSignal` in Python and Rust.

## What a stop does

Setting the stop ends the run as soon as it can, and always leaves the session consistent:

- a model call in flight is abandoned at once, even when the provider ignores the signal, and the run continues as [loop.md](loop.md) describes for a stop
- a backoff wait between retries ends at once
- a tool that is running sees the stop on `ctx.signal`, and may finish early; the run waits for it, since its result belongs in the session
- a call of the turn that has not started does not start, and gets the result `The harness stopped before this tool ran.`

Then the turn's results are appended, the `Stopped by <who>.` notice follows, and the run ends with `stopped`.
