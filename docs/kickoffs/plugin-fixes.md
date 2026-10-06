# Kickoff: plugin fixes from the wave 2 review

You are fixing what the review of the docs, supervisor, MCP and dispatch plugins found, now that the core gives them what they were working around. Read `AGENTS.md`, `docs/spec/plugins.md`, the write-up at the bottom of `docs/kickoffs/core-followups.md`, the four packages in `ts/packages/`, and then this brief. When you are done, add your write-up at the bottom of this file.

## The findings to fix

1. **Use the core rather than work around it.** The supervisor's agent runner opens its session with the core's new agent `parent` (reason `supervise`, naming the checked agent and session), puts the material in a context section rather than writing the store directly, and delivers its request as an event. Dispatch uses the agent `parent` (reason `dispatch`, with `parent.agent`) instead of wrapping the store's `create`. Every plugin uses the core's `escapeText` and `escapeAttr` instead of its own copy.
2. **One supervisor session per check.** Give each agent-run check its own id, `<id>-<hex4>`, as dispatch does, so two guards on one store can never mix verdicts, and drop the queue that existed only to prevent that.
3. **The guard never throws.** A host answer that fails, or an agent runner that fails, becomes an `unavailable` verdict, which the guard then treats by its setting.
4. **MCP names.** Drop a server's tool whose flatbed name repeats another, is over 64 characters, or whose schema is not an object, and list it in the `mcp` section with the reason. Check server names in `mcpPlugin()`. On a resumed session, map a rewritten name back to the server's own by listing the server's tools again. Rewrite the unavailable-tools section as guidance: when a task needs one of these tools, say that it is unavailable rather than guessing.
5. **Stops reach long tools.** Pass `ctx.signal` to the supervisor's check, a waiting dispatch, and each MCP call.
6. **Sub-agents report.** The message that starts a sub-agent says that `report` is the only way its answer reaches the agent that dispatched it. A sub-agent that ends without reporting, by reset or otherwise, gives an error result, not a success.
7. **Escaping in prompts.** In the supervisor's rendering of a tool call, render each input field as `<field name="...">`, not as a tag named by the key. Escape the analysis and titles in a refusal's `<failed_check>` elements, and escape document bodies in the docs plugin's sections.
8. **Smaller things.** The dispatch README says, beside `wake`, that a result not waited for lives in the agent object's queue and is lost if the host makes a new agent for the next run. The supervisor package uses 2-space indentation like the others, and its README's "Run a spec" and "Write a spec" sections are cut to what a reader needs. Split `write_doc`'s description into two sentences.

## Done when

`scripts/check.sh ts` passes with a test for each of 2, 3, 4 and 6, and each package's README is still true.

## Time and setting

Work for at most 75 minutes. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Leave `ts/packages/core` alone unless a fix truly needs it. The API key in `.env` is revoked; do not look for another, and never print a value from `.env`. Run long commands in the foreground one at a time.

## Write-up

All eight findings are fixed. `scripts/check.sh ts` passes, with new tests for 2, 3, 4 and 6, and every package README has been reread and rewritten where it changed. The work took about 40 minutes. `ts/packages/core` is unchanged.

### What changed

- **Supervisor.** `agentPass` makes a fresh agent for each check, `<id>-<hex4>`, with the core's agent `parent` (`reason: "supervise"`, the checked agent, session and head entry). The system prompt and the material are context sections, and the request is an event. The queue is gone. The guard catches a failing `answers` function or supervisor and records an unavailable verdict (`the check failed: <message>`, model `none`), passes `ctx.signal` and the checked agent's id, and escapes titles, analysis and guidance in a refusal. A call's fields render as `<field name="...">`. The package uses 2-space indentation, and the README's spec sections are cut by about half. `docs/decisions.md` has a new entry replacing the old "writes its own session start".
- **Dispatch.** The sub-agent gets the agent `parent` with `agent` set, not a wrapped store. A waiting dispatch passes `ctx.signal`. The starting message says `report` is the only way back. Anything but a report is an error result: `The sub-agent <id> finished|reset its session|was stopped|hit an error without calling report, so it gave no answer.`, followed by its last text when it has one. The README says, at `wake`, that a result not waited for lives in the agent object's queue.
- **MCP.** The plugin lists tools with a loose schema and checks each tool itself, because the MCP library rejects a whole list for one tool whose schema is not an object. It drops a tool with a repeated name (the first one listed keeps it), a name over 64 characters, or a non-object schema. The `mcp` section lists those and unreachable servers, and tells the model to say a tool is unavailable rather than guess. A tool kept from a frozen context while its server was down lists the server again at call time to find the server's own name. Each call passes `ctx.signal`.
- **Docs.** Bodies, and timeline summaries, are escaped with the core's functions in sections and in `read_doc`. `edit_doc` accepts a passage quoted in its escaped form, and unescapes the replacement too in that case. `write_doc`'s description is two sentences.

### Changes to public APIs

- `SuperviseInput` gains optional `agent`, the checked agent's id.
- `Verdict` gains optional `supervisor`, the agent id of an agent check.
- `agentPass`'s `id` is now a prefix: sessions are under `<id>-<hex4>`, not `<id>`. A host that listed `store.list('supervisor')` must use `verdict.supervisor`.
- The supervisor's session parent is now `reason: "supervise"`, not `dispatch`.
- Dispatch: a sub-agent that does not report gives `isError: true` with new text. Before, its last text came back as a success.
- `mcpPlugin()` throws for a server name that is not letters, digits and `-`, or that repeats.
- The `mcp` section's text, and `renderCall`'s and `renderDoc`'s output, have changed.

### Question for the lead

Escaping document bodies means the agent sees `&amp;` for `&`. I made `edit_doc` accept either form, so edits keep working. A model may still copy `&amp;` into a `write_doc` body. Should `write_doc` unescape too, or should bodies stay raw in `read_doc`?

### Suggestions

- The guard's unavailable verdict uses `model: "none"` because `Verdict.model` is required. An optional model may read better.
- `whyUnavailable` says "ran out of context" for any reset without a report, including the supervisor calling `reset` itself.
