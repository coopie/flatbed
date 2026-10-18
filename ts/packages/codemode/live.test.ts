// One real conversation in which the model writes a script. Skipped unless FLATBED_LIVE=1. Reads
// ANTHROPIC_API_KEY from .env at the repo root, and never prints it.
import { equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicProvider, createAgent, memoryStore, type Plugin } from '@flatbed/core';
import { readEnv } from '../core/env.ts';
import { withCodemode } from './index.ts';

const docs: Record<string, string> = {
  'harbour-notes': 'The harbour master is Ines. Boats leave at 7.',
  'tide-table': 'High tide at Port Ness is at 06:10 and 18:32.',
  'shopping': 'Rope, two buckets, bait.',
  'crew': 'Crew this week: Ada, Tomas, Ines.',
};

test('live: the model reads several documents in one script', { skip: process.env.FLATBED_LIVE !== '1' }, async () => {
  const apiKey = await readEnv('ANTHROPIC_API_KEY');
  ok(apiKey, 'ANTHROPIC_API_KEY is not set in .env');
  const tools: Plugin = {
    name: 'docs',
    context: () => ({
      sections: [{ name: 'soul', text: 'You are a test agent. Answer in one short sentence.' }],
      tools: [
        { name: 'list_docs', description: 'List the names of your documents.', inputSchema: { type: 'object', properties: {} }, run: () => JSON.stringify(Object.keys(docs)) },
        {
          name: 'read_doc',
          description: 'Read one of your documents by name.',
          inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          run: (input) => docs[String(input.name)] ?? `No document named ${input.name}.`,
        },
      ],
    }),
  };
  const store = memoryStore();
  const agent = createAgent(
    { id: 'live', model: 'anthropic/claude-sonnet-5-5', plugins: withCodemode([tools], { tools: ['list_docs', 'read_doc'] }), maxTokens: 2048 },
    { store, providers: { anthropic: anthropicProvider({ apiKey }) } },
  );
  agent.deliver({ kind: 'message', attrs: { from: 'Tester' }, text: 'With one run_script call, read every document and tell me which ones mention Ines.' });
  equal(await agent.run(), 'idle');
  const { entries } = await store.read('live', (await store.list('live'))[0]!);
  const scripts = entries.flatMap((e) =>
    e.type === 'message' && e.message.role === 'assistant' ? e.message.content.filter((b) => b.type === 'toolCall' && b.name === 'run_script') : [],
  );
  ok(scripts.length >= 1, 'the model should call run_script');
  const nested = entries.filter((e) => e.type === 'custom' && e.plugin === 'codemode');
  ok(nested.length >= 4, `the script should read the documents, but made ${nested.length} calls`);
  const last = entries.at(-1);
  ok(last?.type === 'message' && last.message.role === 'assistant');
  const answer = JSON.stringify(last.message.content);
  ok(answer.includes('harbour-notes') && answer.includes('crew'), answer);
});
