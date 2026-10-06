/**
 * The mcp plugin: tools served by MCP servers, in any language, joined to a flatbed agent. When a
 * session opens, it lists each server's tools and adds them as `<server>__<tool>`. A server that
 * fails never stops the loop: its failure becomes a tool result, or leaves its tools out, and the
 * `mcp` section tells the model which tools are missing and why.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PaginatedResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { escapeAttr, escapeText, type Plugin, type PluginContext, type Section, type Tool, type ToolDefinition, type ToolResult } from '@flatbed/core';

/** An MCP server: a command to run over stdio, or a streamable HTTP URL. */
export type McpServer =
  | { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { name: string; url: string; headers?: Record<string, string> };

export type McpPlugin = Plugin & {
  /** Closes every connection, which stops stdio servers. Call it when the host shuts down. */
  close(): Promise<void>;
};

const SEPARATOR = '__';
/** Providers limit a tool name to 64 characters. */
const MAX_NAME = 64;

/** A tool a server lists that the plugin leaves out, with why, for the `mcp` section. */
type Dropped = { mcpName: string; reason: string };

/** Throws when a server's name is not letters, digits and `-`, or repeats another's, since tool names are built from it. */
function checkServerNames(servers: McpServer[]): void {
  const seen = new Set<string>();
  for (const { name } of servers) {
    if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error(`The MCP server name "${name}" must be letters, digits and -, and not empty.`);
    if (seen.has(name)) throw new Error(`Two MCP servers are named ${name}.`);
    seen.add(name);
  }
}

export function mcpPlugin(servers: McpServer[]): McpPlugin {
  checkServerNames(servers);
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

  /**
   * Lists a server's tools as flatbed definitions, each with the server's own name for it, and the
   * tools left out with why. The list is checked here rather than by the MCP library, which rejects
   * a whole list for one tool it does not accept.
   */
  async function listTools(server: McpServer): Promise<{ tools: { definition: ToolDefinition; mcpName: string }[]; dropped: Dropped[] }> {
    const client = await connect(server);
    const tools: { definition: ToolDefinition; mcpName: string }[] = [];
    const dropped: Dropped[] = [];
    const taken = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, PaginatedResultSchema);
      for (const tool of Array.isArray(page.tools) ? (page.tools as McpTool[]) : []) {
        if (typeof tool?.name !== 'string') continue;
        const name = `${server.name}${SEPARATOR}${flatbedName(tool.name)}`;
        const schema = tool.inputSchema;
        let reason: string | undefined;
        if (typeof schema !== 'object' || schema === null || Array.isArray(schema) || schema.type !== 'object') reason = 'its input schema is not an object';
        else if (name.length > MAX_NAME) reason = `its name, ${name}, is over ${MAX_NAME} characters`;
        else if (taken.has(name)) reason = `its name, ${name}, repeats another tool's`;
        if (reason !== undefined) {
          dropped.push({ mcpName: tool.name, reason });
          continue;
        }
        taken.add(name);
        const description = typeof tool.description === 'string' ? tool.description : '';
        tools.push({ definition: { name, description, inputSchema: schema as Record<string, unknown> }, mcpName: tool.name });
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return { tools, dropped };
  }

  /**
   * A flatbed tool that runs on the server. `mcpName` is the server's name for it. When it is not
   * known, as for a tool a resumed session froze while the server was down, the tool lists the
   * server's tools again to find it, because the flatbed name may have been rewritten.
   */
  function toolFor(server: McpServer, definition: ToolDefinition, mcpName: string | undefined): Tool {
    return {
      ...definition,
      async run(input, ctx) {
        try {
          const client = await connect(server);
          const name = mcpName ?? (await listTools(server)).tools.find((t) => t.definition.name === definition.name)?.mcpName;
          if (name === undefined) return failed(server, `it no longer has a tool named ${definition.name}`);
          return resultOf(await client.callTool({ name, arguments: input }, undefined, { signal: ctx.signal }));
        } catch (error) {
          return failed(server, error instanceof Error ? error.message : String(error));
        }
      },
    };
  }

  /** A server's tools. When the server cannot be reached, falls back to the tools this session already froze. */
  async function toolsOf(server: McpServer, ctx: PluginContext): Promise<{ tools: Tool[]; dropped: Dropped[]; failure?: string }> {
    try {
      const { tools, dropped } = await listTools(server);
      return { tools: tools.map((t) => toolFor(server, t.definition, t.mcpName)), dropped };
    } catch (error) {
      const prefix = `${server.name}${SEPARATOR}`;
      const frozen = ctx.session.entries.findLast((e) => e.type === 'context');
      const known = frozen?.type === 'context' ? frozen.tools.filter((t) => t.name.startsWith(prefix)) : [];
      // A resumed session keeps its tools; each call tries the server again.
      const tools = known.map((t) => toolFor(server, t, undefined));
      return { tools, dropped: [], failure: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    name: 'mcp',
    async context(ctx) {
      const listed = await Promise.all(servers.map((server) => toolsOf(server, ctx)));
      const missing = servers.flatMap((server, i) => {
        const { failure, dropped } = listed[i]!;
        const lines = dropped.map((d) => `<tool server="${escapeAttr(server.name)}" name="${escapeAttr(d.mcpName)}">Left out because ${escapeText(d.reason)}.</tool>`);
        return failure === undefined ? lines : [`<server name="${escapeAttr(server.name)}">The server could not be reached when this session started: ${escapeText(failure)}</server>`, ...lines];
      });
      const sections: Section[] = missing.length === 0 ? [] : [{ name: 'mcp', text: `<unavailable_tools>\n${UNAVAILABLE}\n${missing.join('\n')}\n</unavailable_tools>` }];
      return { sections, tools: listed.flatMap((l) => l.tools) };
    },
    async close() {
      const clients = await Promise.allSettled(connections.values());
      connections.clear();
      await Promise.all(clients.map((c) => (c.status === 'fulfilled' ? c.value.close() : undefined)));
    },
  };
}

const UNAVAILABLE =
  'Some of your tools are unavailable in this session, as listed below. When a task needs one of them, say that the tool is unavailable and why, rather than guessing what it would have returned.';

const failed = (server: McpServer, message: string): ToolResult => ({ content: [{ type: 'text', text: `The MCP server ${server.name} failed: ${message}` }], isError: true });

/** Providers accept tool names of letters, digits, `_` and `-`; MCP allows more. */
function flatbedName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** A tool as a server lists it: data from outside, checked before use. */
type McpTool = { name?: unknown; description?: unknown; inputSchema?: { type?: unknown } | null };

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
