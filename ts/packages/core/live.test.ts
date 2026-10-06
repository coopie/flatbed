// One short real conversation through the Anthropic provider, with one tool call. Skipped unless
// FLATBED_LIVE=1. Reads ANTHROPIC_API_KEY from .env at the repo root, and never prints it.
import { equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { readEnv } from './env.ts';
import { createAgent } from './loop.ts';
import { anthropicProvider } from './providers/anthropic.ts';
import { memoryStore } from './store.ts';

test('live: a short conversation with one tool call', { skip: process.env.FLATBED_LIVE !== '1' }, async () => {
  const apiKey = await readEnv('ANTHROPIC_API_KEY');
  ok(apiKey, 'ANTHROPIC_API_KEY is not set in .env');
  const store = memoryStore();
  const plugin = {
    name: 'live',
    context: () => ({
      sections: [{ name: 'soul', text: 'You are a test agent. Use your tools when asked. Answer in one short sentence.', cache: true }],
      tools: [
        {
          name: 'add',
          description: 'Add two numbers. Use it for any sum you are asked to work out.',
          inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
          run: (input: Record<string, unknown>) => String(Number(input.a) + Number(input.b)),
        },
      ],
    }),
  };
  const agent = createAgent(
    { id: 'live', model: 'anthropic/claude-sonnet-5-5', plugins: [plugin], maxTokens: 1024 },
    { store, providers: { anthropic: anthropicProvider({ apiKey }) } },
  );
  agent.deliver({ kind: 'message', attrs: { from: 'Tester' }, text: 'Use the add tool to work out 1234 + 4321, then tell me the answer.' });
  const outcome = await agent.run();
  const [id] = await store.list('live');
  const { entries } = await store.read('live', id!);
  const failure = entries.find((e) => e.type === 'event' && e.text.startsWith('The model call failed'));
  equal(outcome, 'idle', failure?.type === 'event' ? failure.text : `run ended ${outcome}`);
  const results = entries.filter((e) => e.type === 'message' && e.message.role === 'tool');
  equal(results.length, 1);
  const last = entries.at(-1);
  ok(last?.type === 'message' && last.message.role === 'assistant');
  ok(JSON.stringify(last.message.content).replace(/,/g, '').includes('5555'), 'the answer should include 5555');
});
