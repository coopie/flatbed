# The loop

The loop is the whole harness. It asks the model for the next step, runs the tools the model calls, and appends everything to the session, until nothing new needs an answer. Keep it short enough to read in one screen in every implementation.

## A run

A host calls `run(agent)`, optionally with a stop signal that says who stopped the run. A run reads the session from the store each time, since the host may have appended to it between runs. A run:

1. **Opens a session if none is open.** The agent's open session is its newest session, unless that session ends in a `reset`. To open one, collect sections and tools from every plugin's `context` hook in plugin order, add the core `reset` tool, write the header and a `context` entry, and append a `notice` event saying why the session started: `Session started.` for an agent's first, or `Session started after a reset: <reason>` after one, or `Session started after a reset.` when the reset gave no reason.
2. **Repairs the session.** Take the last assistant message on the path. For each of its tool calls that has no `tool` message after it on the path, append one, in call order, with `isError: true` and the text `The harness stopped before this tool ran.` A crash, even one partway through a turn's results, then never leaves the model looking at a call with no answer.
3. **Delivers waiting events.** The host may queue events while the agent runs. Append everything queued, in order. A host may queue an event with an earlier entry as its parent, to rewind, as [sessions.md](sessions.md) describes.
4. **Loops while the session needs a run.** A session needs a run when the last entry on its path is an `event` or a `tool` message. Each turn:
   1. When the stop signal is set, append a `notice` event, `Stopped by <who>.`, and end the run.
   2. Render the path and call the provider with the context, the messages and the agent's model.
   3. Append the assistant message. When the provider fails after its retries, append an assistant message with `stop: "error"`, empty content, the agent's full model name and zero `input` and `output` usage, then a `notice` event, `The model call failed: <error message>`, and end the run with `error`. When the call failed because the stop signal was set during it, treat it as step i instead.
   4. Run each tool call, as [plugins.md](plugins.md) describes, and append a `tool` message for each, in the order the calls appear. Calls may run concurrently; results are appended in call order.
   5. When a tool requested a reset, append a `reset` entry with `by: "agent"` and the reason of the first request, and end the run with `reset`.
   6. Check the budget, as below.
   7. Deliver waiting events.
5. **Ends** and returns why: `idle`, `reset`, `stopped` or `error`.

When the assistant message has no tool calls and nothing was delivered, the session no longer needs a run and the loop ends with `idle`.

## The budget

The budget keeps a session from outgrowing the model's context. Its size is `input + output` from the last assistant message's `usage`, plus `cacheRead` and `cacheWrite` when present.

- When the size first passes the agent's `softLimit`, append a `notice` event once in that session: `This session is nearly full. Bring your notes up to date, then call reset.`
- When the size passes `hardLimit`, append a `reset` entry with `by: "harness"` and `reason: "context budget"`, and end the run with `reset`.

Defaults are a soft limit of 120,000 tokens and a hard limit of 180,000.

## The `reset` tool

The core provides one tool:

- **name**: `reset`
- **description**: `End this session and start a fresh one. Call it when your notes are up to date and the session is long, or when the work is finished. Anything not written down will be forgotten.`
- **input**: an object with an optional string `reason`.
- **result**: the text `Session will reset after this turn.`

The reset happens after the turn's results are appended, so a reset never sits between a call and its result.

## One run at a time

The host must not run the same agent twice at once. An implementation offers no locking beyond a simple in-process guard; a host on several machines uses its own lock, such as a Postgres advisory lock.
