/**
 * The mcp plugin: tools served by MCP servers, in any language, joined to a flatbed agent. When a
 * session opens, it lists each server's tools and adds them as `<server>__<tool>`. A server that
 * fails never stops the loop: its failure becomes a tool result, or leaves its tools out.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Plugin, PluginContext, Section, Tool, ToolDefinition, ToolResult } from '@flatbed/core';

/** An MCP server: a command to run over stdio, or a streamable HTTP URL. */
export type McpServer =
  | { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { name: string; url: string; headers?: Record<string, string> };

export type McpPlugin = Plugin & {
  /** Closes every connection, which stops stdio servers. Call it when the host shuts down. */
  close(): Promise<void>;
};

const SEPARATOR = '__';

export function mcpPlugin(servers: McpServer[]): McpPlugin {
  // One connection per server for the life of the process, made when first needed.
  const connections = new Map<string, Promise<Client>>();

  function connect(server: McpServer): Promise<Client> {
    const existing = connections.get(server.name);
    if (existing !== undefined) return existing;
    const connecting = (async () => {
      const client = new Client({ name: 'flatbed', version: '0.1.0' });
      const transport =
        'url' in server
          ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } })
          : new StdioClientTransport({ command: server.command, args: server.args ?? [], env: server.env, cwd: server.cwd, stderr: 'ignore' });
      // A server that exits or drops the connection is connected again on the next call.
      client.onclose = () => void connections.delete(server.name);
      await client.connect(transport);
      return client;
    })();
    connecting.catch(() => connections.delete(server.name));
    connections.set(server.name, connecting);
    return connecting;
  }

  function toolFor(server: McpServer, definition: ToolDefinition, mcpName: string): Tool {
    return {
      ...definition,
      async run(input) {
        try {
          const client = await connect(server);
          return resultOf(await client.callTool({ name: mcpName, arguments: input }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text', text: `The MCP server ${server.name} failed: ${message}` }], isError: true };
        }
      },
    };
  }

  /** Lists a server's tools. When the server cannot be reached, falls back to the tools this session already froze. */
  async function toolsOf(server: McpServer, ctx: PluginContext): Promise<{ tools: Tool[]; failure?: string }> {
    const prefix = `${server.name}${SEPARATOR}`;
    try {
      const client = await connect(server);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        for (const tool of page.tools) {
          const definition = { name: prefix + flatbedName(tool.name), description: tool.description ?? '', inputSchema: tool.inputSchema };
          tools.push(toolFor(server, definition, tool.name));
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return { tools };
    } catch (error) {
      const frozen = ctx.session.entries.findLast((e) => e.type === 'context');
      const known = frozen?.type === 'context' ? frozen.tools.filter((t) => t.name.startsWith(prefix)) : [];
      // A resumed session keeps its tools; each call tries the server again.
      const tools = known.map((t) => toolFor(server, t, t.name.slice(prefix.length)));
      return { tools, failure: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    name: 'mcp',
    async context(ctx) {
      const listed = await Promise.all(servers.map((server) => toolsOf(server, ctx)));
      const failed = servers.flatMap((server, i) => (listed[i]?.failure === undefined ? [] : [`<server name="${escape(server.name)}">${escape(listed[i].failure)}</server>`]));
      const sections: Section[] = failed.length === 0 ? [] : [{ name: 'mcp', text: `<unavailable_tools>\nThese tool servers could not be reached when this session started, so their tools are missing:\n${failed.join('\n')}\n</unavailable_tools>` }];
      return { sections, tools: listed.flatMap((l) => l.tools) };
    },
    async close() {
      const clients = await Promise.allSettled(connections.values());
      connections.clear();
      await Promise.all(clients.map((c) => (c.status === 'fulfilled' ? c.value.close() : undefined)));
    },
  };
}

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Providers accept tool names of letters, digits, `_` and `-`; MCP allows more. */
function flatbedName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

type McpContent = { type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown };

/** Turns an MCP tool result into a flatbed one. Content flatbed has no block for is passed on as JSON text. */
function resultOf(result: Record<string, unknown>): ToolResult {
  const content = (Array.isArray(result.content) ? result.content : []) as McpContent[];
  const blocks: ToolResult['content'] = content.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
    if (block.type === 'image' && typeof block.data === 'string') return { type: 'image', mimeType: block.mimeType ?? 'image/png', data: block.data };
    return { type: 'text', text: JSON.stringify(block) };
  });
  if (blocks.length === 0 && result.structuredContent !== undefined) blocks.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
  return { content: blocks, isError: result.isError === true };
}
