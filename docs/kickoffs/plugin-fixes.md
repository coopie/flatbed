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
