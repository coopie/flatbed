// Tests for the loop that the conformance suite cannot express, such as what a tool sees in its context.
import { deepEqual, equal } from 'node:assert/strict';
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
