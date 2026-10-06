# @flatbed/mcp

Use this plugin to give an agent tools written in any language. You write the tool as an MCP server, in Python, Rust or anything else with an MCP library, and the plugin adds its tools to the agent. The core knows nothing about MCP.

When a session opens, the plugin connects to each server, lists its tools and adds them as flatbed tools named `<server>__<tool>`, such as `units__convert_length`. A call runs on the server. Connections last for the life of the process, and a server that drops is connected again on the next call.

A server that fails never stops the loop. A failed call becomes an error result that names the server and says what went wrong, so the model can try again or carry on. A server that cannot be reached when a session opens leaves its tools out, and the plugin adds a short `mcp` section telling the model which tools are missing. When a run resumes a session whose context already has a server's tools, those tools stay, and each call tries the server again.

## Set it up

Give the plugin a list of servers. Each is a command it starts and talks to over stdio, or a streamable HTTP URL.

```ts
import { createAgent, fileStore, anthropicProvider } from '@flatbed/core';
import { mcpPlugin } from '@flatbed/mcp';

const mcp = mcpPlugin([
  { name: 'units', command: 'uv', args: ['run', 'examples/mcp-python/server.py'] },
  { name: 'calendar', url: 'https://calendar.example.org/mcp', headers: { authorization: `Bearer ${token}` } },
]);

const agent = createAgent(
  { id: 'assistant', model: 'anthropic/claude-opus-5-5', plugins: [mcp] },
  { store: fileStore('data/sessions'), providers: { anthropic: anthropicProvider({ apiKey }) } },
);

await agent.run();
await mcp.close(); // when the host shuts down: stops the stdio servers
```

A stdio server gets only a small set of your environment variables, such as `PATH` and `HOME`. Pass anything else it needs, such as a key, in `env`.

Name servers with letters, digits and `-`, and keep the names short: providers limit a tool name to 64 characters, and the name includes the server's.

## The Python example

[examples/mcp-python/server.py](../../../examples/mcp-python/server.py) is a unit converter with two tools, written with the official Python MCP library in about 40 lines. Run it on its own with `uv run server.py`, or with `--http` to serve it at `http://127.0.0.1:8000/mcp`. `mcp.test.ts` runs a TypeScript agent with a scripted model that calls it, and skips that test when `uv` is not installed.

## Tests

From this folder, `node --test "*.test.ts"`. The tests need no network once `uv` has cached the Python MCP library.
