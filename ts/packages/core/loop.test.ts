// Tests for the loop that the conformance suite cannot express, such as what a tool sees in its context.
import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent } from './loop.ts';
import { fauxProvider } from './providers/faux.ts';
import { memoryStore } from './store.ts';
import type { Plugin, Tool } from './types.ts';

const callWait = { content: [{ type: 'toolCall' as const, id: 'c1', name: 'wait', input: {} }] };

function agentWith(tool: Tool) {
  const store = memoryStore();
  const plugin: Plugin = { name: 'test', context: () => ({ tools: [tool] }) };
  const providers = { faux: fauxProvider([callWait, { content: [{ type: 'text', text: 'Done.' }] }]) };
  const agent = createAgent({ id: 'a', model: 'faux/test', plugins: [plugin] }, { store, providers });
  return { agent, store };
}

test('a tool sees the run stop signal, and can stop when the run is stopped', async () => {
  const controller = new AbortController();
  const tool: Tool = {
    name: 'wait',
    description: 'Wait until the run is stopped.',
    inputSchema: { type: 'object' },
    run: (_input, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve(`Stopped waiting: ${ctx.signal.reason}`));
        controller.abort('Sam');
      }),
  };
  const { agent, store } = agentWith(tool);
  agent.deliver({ kind: 'message', text: 'Wait' });
  equal(await agent.run({ signal: controller.signal }), 'stopped');

  const { entries } = await store.read('a', (await store.list('a'))[0]!);
  const texts = entries.slice(-2).map((e) => (e.type === 'message' && e.message.role === 'tool' ? e.message.content[0] : e));
  deepEqual(texts[0], { type: 'text', text: 'Stopped waiting: Sam' });
  equal(texts[1]?.type === 'event' && texts[1].text, 'Stopped by Sam.');
});

test('a tool sees a signal that is never set when the host gives none', async () => {
  let aborted: boolean | undefined;
  const tool: Tool = {
    name: 'wait',
    description: 'Report whether the run is stopped.',
    inputSchema: { type: 'object' },
    run: (_input, ctx) => {
      aborted = ctx.signal.aborted;
      return 'Not stopped.';
    },
  };
  const { agent } = agentWith(tool);
  agent.deliver({ kind: 'message', text: 'Check' });
  equal(await agent.run(), 'idle');
  equal(aborted, false);
});

test('no more than maxConcurrentTools calls run at once, and results keep call order', async () => {
  let active = 0;
  let most = 0;
  const tool: Tool = {
    name: 'wait',
    description: 'Wait a moment.',
    inputSchema: { type: 'object' },
    run: async (input) => {
      active += 1;
      most = Math.max(most, active);
      // Later calls finish first, so that call order and finishing order differ.
      await new Promise((resolve) => setTimeout(resolve, 20 - Number(input.n) * 3));
      active -= 1;
      return `done ${input.n}`;
    },
  };
  const calls = [0, 1, 2, 3, 4].map((n) => ({ type: 'toolCall' as const, id: `c${n}`, name: 'wait', input: { n } }));
  const store = memoryStore();
  const plugin: Plugin = { name: 'test', context: () => ({ tools: [tool] }) };
  const providers = { faux: fauxProvider([{ content: calls }, { content: [{ type: 'text', text: 'Done.' }] }]) };
  const agent = createAgent({ id: 'a', model: 'faux/test', plugins: [plugin], maxConcurrentTools: 2 }, { store, providers });
  agent.deliver({ kind: 'message', text: 'Go' });
  equal(await agent.run(), 'idle');

  equal(most, 2);
  const { entries } = await store.read('a', (await store.list('a'))[0]!);
  const results = entries.flatMap((e) => (e.type === 'message' && e.message.role === 'tool' ? [e.message.content[0]] : []));
  deepEqual(results, [0, 1, 2, 3, 4].map((n) => ({ type: 'text', text: `done ${n}` })));
});

test('createAgent fails at once, in the words host.md gives', () => {
  const deps = { store: memoryStore(), providers: { faux: fauxProvider([]) } };
  throws(() => createAgent({ id: 'a', model: 'nowhere/test' }, deps), { message: 'No provider named nowhere for the model nowhere/test.' });
  throws(() => createAgent({ id: 'a', model: 'faux/test', maxConcurrentTools: 0 }, deps), { message: 'maxConcurrentTools must be at least 1, not 0.' });
  const toolExecution = 'parallel' as 'serial';
  throws(() => createAgent({ id: 'a', model: 'faux/test', toolExecution }, deps), { message: 'toolExecution must be concurrent or serial, not parallel.' });
});

test('every hook sees the run stop signal, and a stop with no name is by the host', async () => {
  const controller = new AbortController();
  const seen: boolean[] = [];
  const tool: Tool = { name: 'wait', description: 'Stop the run.', inputSchema: { type: 'object' }, run: () => (controller.abort(), 'Stopped.') };
  const plugin: Plugin = {
    name: 'test',
    context: (ctx) => (seen.push(ctx.signal === controller.signal), { tools: [tool] }),
    onEntry: (_entry, ctx) => void seen.push(ctx.signal === controller.signal),
  };
  const store = memoryStore();
  const providers = { faux: fauxProvider([callWait]) };
  const agent = createAgent({ id: 'a', model: 'faux/test', plugins: [plugin] }, { store, providers });
  agent.deliver({ kind: 'message', text: 'Wait' });
  equal(await agent.run({ signal: controller.signal }), 'stopped');
  equal(seen.length > 1 && seen.every(Boolean), true);
  const { entries } = await store.read('a', (await store.list('a'))[0]!);
  const last = entries.at(-1);
  equal(last?.type === 'event' && last.text, 'Stopped by the host.');
});
