// One real session on Opus 5.5, with thinking, that opens with startup.json: a system read and an
// opening read, then two messages, the second of which needs a tool call. It goes through the path
// that opening calls change, which the scripted provider cannot judge. Skipped unless FLATBED_LIVE=1.
// Reads ANTHROPIC_API_KEY from .env at the repo root, and never prints it.
import { equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicProvider, createAgent, memoryStore, type Entry } from '@flatbed/core';
import { readEnv } from '../core/env.ts';
import { docsPlugin, memoryDocStore, STARTUP_DOC } from './index.ts';

const text = (entries: Entry[]) => JSON.stringify(entries.at(-1));

test('live: a session that opens with startup.json answers from its opening read', { skip: process.env.FLATBED_LIVE !== '1' }, async () => {
  const apiKey = await readEnv('ANTHROPIC_API_KEY');
  ok(apiKey, 'ANTHROPIC_API_KEY is not set in .env');
  const docs = memoryDocStore();
  await docs.put({ name: 'soul', summary: 'Who you are', body: 'You are Wren, a test agent. Answer in one short sentence.', pinned: false, writtenBy: 'test' });
  await docs.put({ name: 'notes', summary: 'Open threads', body: 'The code word for today is marmalade.', pinned: false, writtenBy: 'test' });
  await docs.put({ name: 'plans', summary: 'Plans for the week', body: 'Walk the dog at noon on Thursday.', pinned: false, writtenBy: 'test' });
  await docs.put({
    name: STARTUP_DOC, summary: 'What a session opens with', writtenBy: 'test', pinned: false,
    body: JSON.stringify([{ name: 'read_doc', input: { name: 'soul' }, system: true, fixed: true }, { name: 'read_doc', input: { name: 'notes' } }]),
  });
  const store = memoryStore();
  const plugin = docsPlugin({ store: docs, startup: [{ name: 'read_doc', input: { name: 'soul' }, system: true }] });
  const agent = createAgent({ id: 'live', model: 'anthropic/claude-opus-5-5', plugins: [plugin], maxTokens: 4096 }, { store, providers: { anthropic: anthropicProvider({ apiKey }) } });

  agent.deliver({ kind: 'message', attrs: { from: 'Tester' }, text: 'What is the code word in your notes?' });
  const first = await agent.run();
  const [id] = await store.list('live');
  let { entries } = await store.read('live', id!);
  equal(first, 'idle', text(entries));
  ok(text(entries).toLowerCase().includes('marmalade'), 'the answer should give the code word');

  agent.deliver({ kind: 'message', attrs: { from: 'Tester' }, text: 'Read your plans document and tell me what happens on Thursday.' });
  const second = await agent.run();
  ({ entries } = await store.read('live', id!));
  equal(second, 'idle', text(entries));
  ok(entries.some((e) => e.type === 'message' && e.message.role === 'tool' && e.message.callId !== 'opening-1'), 'the model should have called a tool');
  ok(text(entries).toLowerCase().includes('dog'), 'the answer should mention the dog');
  console.log(`session ${id}: ${entries.length} entries`);
  for (const e of entries) {
    if (e.type === 'message') console.log(e.message.role, e.message.role === 'assistant' ? `${e.message.model} ${e.message.content.map((b) => b.type).join(',')} ${JSON.stringify(e.message.usage)}` : '');
    else console.log(e.type, e.type === 'event' ? e.text.slice(0, 60) : '');
  }
});
