# Kickoff: tools from MCP servers, and sub-agents

You are building two small plugins that widen what a flatbed agent can do without growing the core. `@flatbed/mcp` lets a tool written in any language join an agent, by serving it over MCP. `@flatbed/dispatch` lets an agent hand a piece of work to a sub-agent and hear back. Read `AGENTS.md` and the docs it lists, `docs/spec/plugins.md` and `docs/spec/sessions.md`, the code in `ts/packages/core`, and then this brief. When you are done, add your write-up at the bottom of this file.

## MCP

- `ts/packages/mcp`: a plugin configured with a list of MCP servers, each a stdio command or a streamable HTTP URL. When a session opens, its `context` hook connects, lists each server's tools and adds them as flatbed tools named `<server>__<tool>`, whose `run` calls the server. Server failures become tool results that say what went wrong, never a crash of the loop.
- Use the official `@modelcontextprotocol/sdk` client if it saves real work over a few dozen lines of JSON-RPC; say which you chose and why in the write-up.
- Keep connections for the life of the process, and close them on shutdown.
- **Show the point of it**: write a tiny MCP server in Python in `examples/mcp-python/`, with one or two invented tools (for example a unit converter), runnable with `uv run`, and a test that runs a faux-driven TypeScript agent calling one of its tools. Skip that test with a clear message when `uv` is missing.

## Dispatch

- `ts/packages/dispatch`: a plugin that adds a `dispatch` tool. The agent passes a brief, and optionally the name of a sub-agent the host configured and whether to wait.
- A sub-agent is an ordinary flatbed agent with its own sessions, whose first session's header has `parent` set to the dispatching session and entry, with `reason: "dispatch"`. Its context is the sub-agent's configured sections plus the brief. It gets one extra tool, `report`, which ends its work with an answer.
- **Waiting**: the dispatch tool runs the sub-agent's loop to the end and returns the reported answer, or the sub-agent's last text when it stopped without reporting.
- **Not waiting**: the tool returns at once, saying the work was dispatched, and when the sub-agent reports, the plugin delivers a `dispatch_result` event to the parent and calls a `wake(agentId)` function the host supplies, so the host can run the parent again.
- Bound it: a depth limit, so sub-agents cannot dispatch forever, and the sub-agent's own budget.
- Tests with the faux provider for both modes, checking the parent link in the child's header.
- Add a short section on dispatch to `docs/spec/sessions.md` if the header's `parent` needs more than it says now, and add a conformance scenario only if the core changes.

## For both

Each package has a README of a page or less: what it is for, how a host sets it up, and an example. Strict, erasable TypeScript, `node --test`, in the style of the rest of `ts/`.

## Done when

`scripts/check.sh ts` passes with both packages' tests included, the Python MCP server works from a TypeScript agent, and both READMEs show a reader how to use the plugin.

## Time and setting

Work for at most 90 minutes. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Other agents are working in other worktrees at the same time; change `ts/packages/core` only when you must, and then say so in the write-up. Run long commands in the foreground one at a time.

## Write-up

**What changed.** `ts/packages/mcp` adds MCP servers' tools as `<server>__<tool>`, over stdio or streamable HTTP, with one connection per server for the process and `close()` for shutdown. Failed calls become error results naming the server. A server down at session open leaves its tools out and adds an `mcp` section saying so; a resumed session keeps its frozen MCP tools and retries on each call. `examples/mcp-python/server.py` is a two-tool unit converter run with `uv run`. `ts/packages/dispatch` adds `dispatch` (brief, agent, wait) and gives each sub-agent `report`. One line in `docs/spec/sessions.md` says a dispatch's `parent.session` belongs to the dispatching agent. No core change, so no conformance scenario.

**Choices.** I used the official `@modelcontextprotocol/sdk` client: streamable HTTP alone (SSE responses, session headers, version negotiation) is well past a few dozen lines. The cost is 95 packages in the lockfile. The Python server pins `mcp<2`, since 2.x renamed FastMCP. Each dispatch makes a fresh sub-agent, `<parent>.<name>-<hex4>`, and runs one session of it; the parent link is set by wrapping the store's `create`, which kept the core untouched. `maxDepth` defaults to 1, so sub-agents cannot dispatch. The brief is a `brief` section, so it survives a reset. A `custom` entry in the parent records the child's id.

**Commands.** `scripts/check.sh ts`: all passed, 8 new tests (Python server via uv, an in-process HTTP server, a missing command, a down server on resume; dispatch waiting, stopped without report, not waiting with wake, depth 2).

**Left out.** Not-waiting results live in the agent's in-process queue, so a restart loses them. No stop signal reaches sub-agents. MCP tool names with characters providers reject are rewritten to `_`, and on the resume fallback the rewritten name is called. `docs/overview.md` still lists MCP and dispatch as next; I left it to avoid conflicts.

**How it went.** Smooth; the spec and core were accurate. The 2.x Python rename cost one retry.

## Question for the lead

Should the header's `parent` name the dispatching agent, such as `parent.agent`? Without it, the link is found only through the sub-agent's id. My guess: yes, as an optional field in the spec, types and suite, but it touches the core, so I left it.
