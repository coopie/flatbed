// The three steps and the fact sheet's lines, as the project page reads them from a session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '@flatbed/core';
import { facts, steps } from './view.ts';

const call = (name: string, input: Record<string, unknown>) => ({ type: 'toolCall', id: name, name, input });
const session = (...calls: ReturnType<typeof call>[]) =>
  ({ header: { id: 's1' }, entries: calls.map((c) => ({ type: 'message', message: { role: 'assistant', content: [c] } })) }) as unknown as Session;

test('the steps follow the tool calls, and the last one reached is under way while the agent runs', () => {
  assert.deepEqual(steps([], false), { reading: 'waiting', organising: 'waiting', writing: 'waiting' });
  const reading = session(call('fetch_page', { url: 'https://acme.example' }));
  assert.deepEqual(steps([reading], true), { reading: 'now', organising: 'waiting', writing: 'waiting' });
  const organising = session(call('fetch_page', { url: 'x' }), call('write_doc', { name: 'notes/fact-sheet' }));
  assert.deepEqual(steps([organising], true), { reading: 'done', organising: 'now', writing: 'waiting' });
  const writing = session(call('write_doc', { name: 'notes/fact-sheet' }), call('write_doc', { name: 'outbox/intro' }));
  assert.deepEqual(steps([writing], false), { reading: 'done', organising: 'done', writing: 'done' });
});

test('a fact keeps its page apart from its text', () => {
  assert.deepEqual(facts('# Fact sheet\n- Founded in 2019 in Leeds (sources/acme-about)\n- Customers: not stated'), [
    { text: 'Founded in 2019 in Leeds', source: 'sources/acme-about' },
    { text: 'Customers: not stated' },
  ]);
});
