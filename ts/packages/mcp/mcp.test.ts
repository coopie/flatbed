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

type Listed = { name: string; description?: string; inputSchema: unknown };

/**
 * Serves `tools` over streamable HTTP at a local URL, statelessly, and calls `onCall` for each tool
 * call. `failLists` makes that many tools/list requests fail first. Close it when done.
 */
async function serve(tools: Listed[], onCall: (name: string, args: Record<string, unknown>) => { content: unknown[]; isError?: boolean }, failLists = 0) {
  let fails = failLists;
  const http = createServer(async (req, res) => {
    const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (fails > 0) {
        fails -= 1;
        throw new Error('Listing is down.');
      }
      return { tools } as any;
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => onCall(request.params.name, request.params.arguments ?? {}) as any);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    async close() {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

const textSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };

test('tools come over streamable HTTP, and a tool error comes back as an error result', async () => {
  const server = await serve([{ name: 'shout', description: 'Say the text loudly.', inputSchema: textSchema }], (_, args) => {
    const text = String(args.text ?? '');
    if (text === '') return { content: [{ type: 'text', text: 'Nothing to shout.' }], isError: true };
    return { content: [{ type: 'text', text: text.toUpperCase() }] };
  });
  try {
    const twoCalls: ScriptStep = {
      content: [
        { type: 'toolCall', id: 'call_1', name: 'echo__shout', input: { text: 'hello' } },
        { type: 'toolCall', id: 'call_2', name: 'echo__shout', input: { text: '' } },
      ],
    };
    const { session } = await runAgent([{ name: 'echo', url: server.url }], [twoCalls, done]);
    const [first, second] = toolMessages(session);
    assert.deepEqual(first.content, [{ type: 'text', text: 'HELLO' }]);
    assert.equal(first.isError, false);
    assert.deepEqual(second.content, [{ type: 'text', text: 'Nothing to shout.' }]);
    assert.equal(second.isError, true);
  } finally {
    await server.close();
  }
});

test('a tool whose name repeats another, runs over 64 characters or has no object schema is left out and listed', async () => {
  const long = 'x'.repeat(60);
  const server = await serve(
    [
      { name: 'look.up', inputSchema: textSchema },
      { name: 'look_up', inputSchema: textSchema },
      { name: long, inputSchema: textSchema },
      { name: 'loose', inputSchema: { type: 'string' } },
    ],
    (name) => ({ content: [{ type: 'text', text: `ran ${name}` }] }),
  );
  try {
    const { session, requests } = await runAgent([{ name: 'echo', url: server.url }], [call('echo__look_up', { text: 'a' }), done]);
    assert.deepEqual(requests[0]!.tools.map((t) => t.name), ['echo__look_up', 'reset']);
    // The first tool listed keeps the name, and its call reaches the server under its own name.
    assert.deepEqual(toolMessages(session)[0].content, [{ type: 'text', text: 'ran look.up' }]);
    const section = (session.entries[0] as any).sections[0];
    assert.equal(section.name, 'mcp');
    assert.match(section.text, /say that the tool is unavailable/);
    assert.match(section.text, /<tool server="echo" name="look_up">Left out because its name, echo__look_up, repeats another tool's.<\/tool>/);
    assert.match(section.text, new RegExp(`<tool server="echo" name="${long}">Left out because its name, echo__${long}, is over 64 characters.</tool>`));
    assert.match(section.text, /<tool server="echo" name="loose">Left out because its input schema is not an object.<\/tool>/);
  } finally {
    await server.close();
  }
});

test('a server name that is not letters, digits and -, or that repeats, throws', () => {
  assert.throws(() => mcpPlugin([{ name: 'my_server', url: 'http://127.0.0.1:9/mcp' }]), /must be letters, digits and -/);
  assert.throws(() => mcpPlugin([{ name: '', url: 'http://127.0.0.1:9/mcp' }]), /must be letters, digits and -/);
  assert.throws(() => mcpPlugin([{ name: 'a', url: 'http://127.0.0.1:9/mcp' }, { name: 'a', command: 'a' }]), /Two MCP servers are named a/);
});

test('a resumed session that could not list a server maps a rewritten name back by listing again at the call', async () => {
  const called: string[] = [];
  const server = await serve([{ name: 'look.up', inputSchema: textSchema }], (name) => (called.push(name), { content: [{ type: 'text', text: 'found' }] }), 1);
  try {
    const store = memoryStore();
    // A session an earlier process opened, whose context froze the rewritten name.
    const opener = { name: 'mcp', context: () => ({ tools: [{ name: 'echo__look_up', description: 'Look up.', inputSchema: textSchema, run: () => 'x' }] }) };
    await createAgent({ id: 'test', model: 'faux/test', plugins: [opener] }, { store, providers: { faux: fauxProvider([done]) } }).run();

    const plugin = mcpPlugin([{ name: 'echo', url: server.url }]);
    const agent = createAgent({ id: 'test', model: 'faux/test', plugins: [plugin] }, { store, providers: { faux: fauxProvider([call('echo__look_up', { text: 'a' }), done]) } });
    agent.deliver({ kind: 'message', text: 'Look it up.' });
    assert.equal(await agent.run(), 'idle');
    await plugin.close();
    const session = await store.read('test', (await store.list('test'))[0]!);
    assert.deepEqual(toolMessages(session)[0].content, [{ type: 'text', text: 'found' }]);
    assert.deepEqual(called, ['look.up']);
  } finally {
    await server.close();
  }
});

test('a server that cannot start leaves its tools out and the loop running', async () => {
  const { outcome, session, requests } = await runAgent([{ name: 'gone', command: 'flatbed-no-such-command' }], [done]);
  assert.equal(outcome, 'idle');
  assert.deepEqual(requests[0]!.tools.map((t) => t.name), ['reset']);
  const context = session.entries[0] as any;
  assert.match(context.sections[0].text, /<server name="gone">The server could not be reached when this session started: .*ENOENT/);
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
