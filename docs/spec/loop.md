# The loop

The loop is the whole harness. It asks the model for the next step, runs the tools the model calls, and appends everything to the session, until nothing new needs an answer. Keep it short enough to read in one screen in every implementation.

## A run

An agent's configuration may carry a `parent`, written into the header of the agent's first session only, so that a sub-agent or a supervisor links back to the session that started it.

When the newest session holds a header and nothing else, because a process stopped between writing the two, the run treats it as open and writes the `context` entry and the opening notice it is missing.

A host calls `run`, optionally with a stop that says who stopped the run, as [host.md](host.md) describes. A run reads the session from the store each time, since the host may have appended to it between runs. A run:

1. **Opens a session if none is open.** The agent's open session is its newest session, unless that session ends in a `reset`. To open one, collect sections, tools and opening calls from every plugin's `context` hook in plugin order, add the core `reset` tool, write the header and a `context` entry, and append a `notice` event saying why the session started: `Session started.` for an agent's first, or `Session started after a reset: <reason>` after one, or `Session started after a reset.` when the reset gave no reason.
2. **Repairs the session.** Take the last assistant message on the path. For each of its tool calls that has no `tool` message after it on the path, append one, in call order, with `isError: true` and the text `The harness stopped before this tool ran.` A crash, even one partway through a turn's results, then never leaves the model looking at a call with no answer.
3. **Freezes the context.** Take the last `context` entry on the path, and the tools it names, once for the whole run.
4. **Makes the opening calls**, when this run opened the session and the plugins gave any, as below.
5. **Delivers waiting events.** The host may queue events while the agent runs. Append everything queued, in order. A host may queue an event with an earlier entry as its parent, to rewind, as [sessions.md](sessions.md) describes.
6. **Loops while the session needs a run**, as below. Each turn:
   1. When the stop signal is set, append a `notice` event, `Stopped by <who>.`, and end the run.
   2. Render the path and call the provider with the context, the messages, the agent's model and, when the agent sets it, its `effort`.
   3. Append the assistant message. When the provider fails after its retries, append an assistant message with `stop: "error"`, empty content, the agent's full model name and zero `input` and `output` usage, then a `notice` event, `The model call failed: <error message>`, and end the run with `error`. When the call failed because the stop signal was set during it, treat it as step i instead.
   4. Run each tool call, as [plugins.md](plugins.md) describes, and append a `tool` message for each, in the order the calls appear, once the last call has finished. How the calls run depends on the agent's `toolExecution`:
      - `concurrent`, the default: calls start in call order, with at most `maxConcurrentTools` running at once, and the next starts as soon as one finishes
      - `serial`: each call starts only after the one before it has finished

      When the stop is set during the calls, no further call starts, as [host.md](host.md) describes: append every result, then the `Stopped by <who>.` notice, and end the run with `stopped`. When the assistant message's `stop` is `maxTokens`, run none of its calls, since one may be incomplete: give each a `tool` message with `isError: true` and the text `The response was cut off before this call was complete.`, and do not call plugins.
   5. When a tool requested a reset, append a `reset` entry with `by: "agent"` and the reason of the first call to request one, in call order, and end the run with `reset`. A reset wins over a stop set during the same turn, since the model has already been told the session will reset: the run appends the turn's results and the `reset` entry, with no stop notice, and ends with `reset`.
   6. Check the budget, as below.
   7. Deliver waiting events.
7. **Ends** and returns why: `idle`, `reset`, `stopped` or `error`.

## Opening calls

A plugin's `context` hook may return tool calls, as [plugins.md](plugins.md) describes, so that the model starts a session with material it seems to have read itself, such as its notes, rather than with instructions in the system prompt. Right after the start notice, the loop appends one assistant message holding every plugin's calls, in plugin order, then runs them and appends their results, as a turn does in step 6.iv: by the agent's `toolExecution`, through the same checks and hooks, with the same error wording. The model's first exchange is then calls and their real results.

The opening message is the harness's own, and no model call is behind it:

- its `model` is `harness`, its `usage` is zero `input` and `output`, and its `stop` is `toolUse`
- its calls have the ids `opening-1`, `opening-2` and so on, in order
- it adds nothing to the budget, since its usage is zero; the first model call's `input` counts the results
- it and its results never make a session need a run, so a session that opens with calls and nothing else ends the run with `idle`, as a bare `Session started.` does
- a reset an opening call requests is ignored, since the model asked for nothing; when the stop is set during the calls, the results are appended, then the `Stopped by <who>.` notice, and the run ends with `stopped`

When no plugin returns calls, the session opens as it always has. When a run resumes a session an earlier process opened, the calls are ignored with the sections. A crash during the opening calls leaves calls with no results, which step 2 repairs on the next run.

## When a session needs a run

A session needs a run when the last entry on its path, ignoring `custom` and `context` entries, the opening message and the results of its calls, is one of:

- a `tool` message
- an `event` whose `attrs.from` is not `harness`, including an event with no `from`
- the soft-limit notice, or a `Stopped by <who>.` notice with nothing but other such notices between it and the soft-limit notice, so that the model can bring its notes up to date, even when the run that appended it was stopped or the process restarted

Work this out from the session's entries every time, never from a flag held in memory.

So an assistant message with no tool calls ends the run with `idle`, unless something was delivered. Every other notice from the harness, such as `Session started.`, `Stopped by <who>.` or `The model call failed: ...`, waits for the next event that is not from the harness. A run that finds nothing needing an answer ends with `idle` without calling the model, and without checking the stop signal. So a stop set after the model's last answer, in a turn with no tool calls, changes nothing: the run ends with `idle` and writes no stop notice.

## The budget

The budget keeps a session from outgrowing the model's context. Its size is `input + output` from the last assistant message's `usage`, plus `cacheRead` and `cacheWrite` when present. The loop checks it after each turn, in step 6.vi, and never after the opening calls.

- When the size passes the agent's `softLimit` and the session has no soft-limit notice yet, append a `notice` event: `This session is nearly full. Bring your notes up to date, then call reset.` Look for an earlier notice in the session's entries, from the store, not in memory, so that a restarted process does not warn twice. Look in all the entries, not only the path.
- When the size passes `hardLimit`, append a `reset` entry with `by: "harness"` and `reason: "context budget"`, and end the run with `reset`.

Defaults are a soft limit of 120,000 tokens and a hard limit of 180,000.

## The `reset` tool

The core provides one tool:

- **name**: `reset`
- **description**: `End this session and start a fresh one. Call it when your notes are up to date and the session is long, or when the work is finished. Anything not written down will be forgotten.`
- **input**: an object with an optional string `reason`.
- **result**: the text `Session will reset after this turn.`

The reset happens after the turn's results are appended, so a reset never sits between a call and its result. The `reset` entry takes the reason of the first call, in call order, that requested a reset; when that reason is missing or empty, leave `reason` out.

## One run at a time

The host must not run the same agent twice at once. An implementation offers no locking beyond a simple in-process guard; a host on several machines uses its own lock, such as a Postgres advisory lock.
