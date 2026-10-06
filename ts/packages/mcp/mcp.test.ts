import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgent, fauxProvider, memoryStore, type ScriptStep, type Store } from '@flatbed/core';
import { mcpPlugin, type McpServer } from './index.ts';

const PYTHON_SERVER = fileURLToPath(new URL('../../../examples/mcp-python/server.py', import.meta.url));

function hasUv(): boolean {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Runs an agent with the mcp plugin and a scripted model, and returns the session and what the model was sent. */
async function runAgent(servers: McpServer[], script: ScriptStep[]) {
  const store: Store = memoryStore();
  const faux = fauxProvider(script);
  const plugin = mcpPlugin(servers);
  try {
    const agent = createAgent({ id: 'test', model: 'faux/test', plugins: [plugin] }, { store, providers: { faux } });
    agent.deliver({ kind: 'message', attrs: { from: 'Sam' }, text: 'Go ahead.' });
    const outcome = await agent.run();
    const session = await store.read('test', (await store.list('test'))[0]!);
    return { outcome, session, requests: faux.requests };
  } finally {
    await plugin.close();
  }
}

const call = (name: string, input: Record<string, unknown>): ScriptStep => ({ content: [{ type: 'toolCall', id: 'call_1', name, input }] });
const done: ScriptStep = { content: [{ type: 'text', text: 'Done.' }] };

function toolMessages(session: { entries: { type: string }[] }) {
  return session.entries.flatMap((e: any) => (e.type === 'message' && e.message.role === 'tool' ? [e.message] : []));
}

test('a TypeScript agent calls a tool on the Python MCP server', { skip: hasUv() ? false : 'uv is not installed, so the Python MCP server cannot run', timeout: 240_000 }, async () => {
  const { outcome, session, requests } = await runAgent(
    [{ name: 'units', command: 'uv', args: ['run', '--quiet', PYTHON_SERVER] }],
    [call('units__convert_length', { value: 5, from_unit: 'km', to_unit: 'mi' }), done],
  );
  assert.equal(outcome, 'idle');
  assert.deepEqual(requests[0]!.tools.map((t) => t.name), ['units__convert_length', 'units__convert_temperature', 'reset']);
  assert.deepEqual(toolMessages(session)[0], {
    role: 'tool', callId: 'call_1', name: 'units__convert_length', content: [{ type: 'text', text: '5 km is 3.10686 mi' }], isError: false,
  });
});

test('tools come over streamable HTTP, and a tool error comes back as an error result', async () => {
  const http = createServer(async (req, res) => {
    // A stateless server: one MCP server and transport per request.
    const server = new Server({ name: 'echo', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'shout', description: 'Say the text loudly.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const text = String(request.params.arguments?.text ?? '');
      if (text === '') return { content: [{ type: 'text', text: 'Nothing to shout.' }], isError: true };
      return { content: [{ type: 'text', text: text.toUpperCase() }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    const twoCalls: ScriptStep = {
      content: [
        { type: 'toolCall', id: 'call_1', name: 'echo__shout', input: { text: 'hello' } },
        { type: 'toolCall', id: 'call_2', name: 'echo__shout', input: { text: '' } },
      ],
    };
    const { session } = await runAgent([{ name: 'echo', url }], [twoCalls, done]);
    const [first, second] = toolMessages(session);
    assert.deepEqual(first.content, [{ type: 'text', text: 'HELLO' }]);
    assert.equal(first.isError, false);
    assert.deepEqual(second.content, [{ type: 'text', text: 'Nothing to shout.' }]);
    assert.equal(second.isError, true);
  } finally {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
});

test('a server that cannot start leaves its tools out and the loop running', async () => {
  const { outcome, session, requests } = await runAgent([{ name: 'gone', command: 'flatbed-no-such-command' }], [done]);
  assert.equal(outcome, 'idle');
  assert.deepEqual(requests[0]!.tools.map((t) => t.name), ['reset']);
  const context = session.entries[0] as any;
  assert.match(context.sections[0].text, /<server name="gone">.*ENOENT/);
});

test('a resumed session keeps its MCP tools when the server is down, and a call says what went wrong', async () => {
  const store = memoryStore();
  const down = mcpPlugin([{ name: 'gone', url: 'http://127.0.0.1:9/mcp' }]);
  // A session an earlier process opened, whose context froze a tool from the server.
  const opener = { name: 'mcp', context: () => ({ tools: [{ name: 'gone__ping', description: 'Ping.', inputSchema: { type: 'object' }, run: () => 'pong' }] }) };
  await createAgent({ id: 'test', model: 'faux/test', plugins: [opener] }, { store, providers: { faux: fauxProvider([done]) } }).run();

  const agent = createAgent({ id: 'test', model: 'faux/test', plugins: [down] }, { store, providers: { faux: fauxProvider([call('gone__ping', {}), done]) } });
  agent.deliver({ kind: 'message', text: 'Ping it.' });
  assert.equal(await agent.run(), 'idle');
  await down.close();
  const session = await store.read('test', (await store.list('test'))[0]!);
  const [result] = toolMessages(session);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^The MCP server gone failed: /);
});
