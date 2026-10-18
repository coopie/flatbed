import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createAgent, fauxProvider, memoryStore, type Entry, type Plugin, type ScriptStep, type Session, type ToolMessage } from '@flatbed/core';
import { withCodemode, type CodemodeOptions } from './index.ts';

const hasUv = spawnSync('uv', ['--version']).status === 0;
const skip = hasUv ? false : 'uv is not installed, so the codemode worker cannot run.';

const call = (name: string, input: Record<string, unknown>): ScriptStep => ({ content: [{ type: 'toolCall', id: 'call_1', name, input }] });
const say = (text: string): ScriptStep => ({ content: [{ type: 'text', text }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An agent whose tools are `slow`, `read_doc` and `send_email`, with codemode allowed the first two. */
function setup(script: string, options: Partial<CodemodeOptions> = {}, onSlow?: (signal: AbortSignal) => void) {
  const spans: { label: string; start: number; end: number }[] = [];
  const sent: string[] = [];
  const tools: Plugin = {
    name: 'tools',
    context: () => ({
      tools: [
        {
          name: 'slow',
          description: 'Wait a moment, then say done.',
          inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
          async run(input, ctx) {
            const start = Date.now();
            onSlow?.(ctx.signal);
            await sleep(300);
            spans.push({ label: String(input.label), start, end: Date.now() });
            return `done ${input.label}`;
          },
        },
        {
          name: 'read_doc',
          description: 'Read one of your documents by name.',
          inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          run: (input) => `contents of ${input.name}`,
        },
        {
          name: 'send_email',
          description: 'Send an email.',
          inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
          run: (input) => void sent.push(String(input.to)) ?? 'sent',
        },
      ],
    }),
  };
  // A guard, to show that nested calls pass through the agent's own hooks.
  const guard: Plugin = {
    name: 'guard',
    beforeTool: (c) => (c.name === 'read_doc' && c.input.name === 'secret' ? { content: [{ type: 'text', text: 'Refused.' }], isError: true } : undefined),
  };
  const store = memoryStore();
  const provider = fauxProvider([call('run_script', { script }), say('Done.')]);
  const agent = createAgent(
    { id: 'coder', model: 'faux/test', plugins: withCodemode([tools, guard], { tools: ['slow', 'read_doc'], ...options }) },
    { store, providers: { faux: provider } },
  );
  agent.deliver({ kind: 'message', attrs: { from: 'Sam' }, text: 'Go.' });
  const session = async (): Promise<Session> => store.read('coder', (await store.list('coder'))[0]!);
  return { agent, provider, session, spans, sent };
}

const scriptResult = (entries: Entry[]): ToolMessage =>
  entries.flatMap((e) => (e.type === 'message' && e.message.role === 'tool' ? [e.message] : []))[0]!;
const textOf = (m: ToolMessage) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
const nested = (entries: Entry[]) => entries.flatMap((e) => (e.type === 'custom' && e.plugin === 'codemode' ? [e.data as { call: { name: string }; result: { isError: boolean } }] : []));

test('two calls gathered in a script run at the same time, through the hooks, and are recorded', { skip }, async () => {
  const { agent, session, spans, provider } = setup(
    "import asyncio\na, b = await asyncio.gather(slow('a'), slow(label='b'))\ntry:\n    await read_doc('secret')\nexcept RuntimeError as e:\n    print('guard said', e)\n[a, b]",
  );
  assert.equal(await agent.run(), 'idle');
  const { entries } = await session();
  const result = scriptResult(entries);
  assert.equal(textOf(result), 'guard said Refused.\n["done a", "done b"]');
  assert.equal(result.isError, false);
  // Each started before the other ended.
  assert.equal(spans.length, 2);
  assert.ok(spans[0]!.start < spans[1]!.end && spans[1]!.start < spans[0]!.end);
  assert.deepEqual(nested(entries).map((n) => [n.call.name, n.result.isError]), [['slow', false], ['slow', false], ['read_doc', true]]);
  // The description lists only the allowed tools, as Python.
  const description = provider.requests[0]!.tools.find((t) => t.name === 'run_script')!.description;
  assert.match(description, /async def slow\(label: str\) -> str:/);
  assert.doesNotMatch(description, /send_email/);
});

test('a tool off the allow-list does not exist inside the script', { skip }, async () => {
  const { agent, session, sent } = setup("await send_email('someone@example.com')");
  await agent.run();
  const result = scriptResult((await session()).entries);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /NameError: name 'send_email' is not defined/);
  assert.deepEqual(sent, []);
});

test('a script that makes more calls than the limit is stopped', { skip }, async () => {
  const { agent, session } = setup("for i in range(10):\n    await read_doc(str(i))", { maxCalls: 3 });
  await agent.run();
  const { entries } = await session();
  const result = scriptResult(entries);
  assert.equal(textOf(result), 'The script made more than 3 tool calls, so it was stopped.');
  assert.equal(result.isError, true);
  assert.equal(nested(entries).length, 3);
});

test('a script that runs past its deadline is stopped', { skip }, async () => {
  const { agent, session } = setup('while True:\n    pass', { timeoutMs: 1000 });
  const started = Date.now();
  await agent.run();
  assert.ok(Date.now() - started < 3000);
  const result = scriptResult((await session()).entries);
  assert.equal(textOf(result), 'The script ran for more than 1 seconds, so it was stopped.');
});

test('a stop during a script ends the script and the run', { skip }, async () => {
  const controller = new AbortController();
  const { agent, session } = setup("await slow('a')\nwhile True:\n    pass", {}, () => setTimeout(() => controller.abort('Sam'), 50));
  assert.equal(await agent.run({ signal: controller.signal }), 'stopped');
  const { entries } = await session();
  assert.equal(textOf(scriptResult(entries)), 'The harness stopped this script.');
  const last = entries.at(-1)!;
  assert.equal(last.type === 'event' && last.text, 'Stopped by Sam.');
});

test('an error in a script comes back with what it printed first', { skip }, async () => {
  const { agent, session } = setup("print('before')\n1 / 0");
  await agent.run();
  const result = scriptResult((await session()).entries);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^before\n/);
  assert.match(textOf(result), /ZeroDivisionError: division by zero/);
});
