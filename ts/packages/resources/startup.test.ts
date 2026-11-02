// Tests of the startup resource at the plugin's boundary: what a session opens with, and which edits land.
import { deepEqual, equal, match, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent, fauxProvider, memoryStore, type Message, type ScriptStep, type ToolCall } from '@flatbed/core';
import { docsPlugin, memoryDocStore } from '@flatbed/docs';
import { createResources, memoryResourceStore, resourcesPlugin, STARTUP, startupResource, type StartupEntry } from './index.ts';

const TODAY = '2026-10-06';
const call = (name: string, input: Record<string, unknown>, id = name): ToolCall => ({ type: 'toolCall', id, name, input });
const say = (text: string): ScriptStep => ({ content: [{ type: 'text', text }] });
const FIXED: StartupEntry[] = [{ name: 'read_doc', input: { name: 'soul' }, system: true }];
const results = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === 'tool' ? [[m.name, m.isError, m.content[0]?.type === 'text' ? m.content[0].text : '']] : []));

async function setUp(script: ScriptStep[], startup?: StartupEntry[]) {
  const docs = memoryDocStore();
  await docs.put({ name: 'soul', summary: 'Who you are', body: 'You are Wren.', pinned: true, writtenBy: 'test' });
  await docs.put({ name: 'rules', summary: 'How you work', body: 'Be brief.', pinned: false, writtenBy: 'test' });
  await docs.put({ name: 'notes', summary: 'Open threads', body: 'Call Tomas.', pinned: false, writtenBy: 'test' });
  const store = memoryResourceStore();
  if (startup !== undefined) await store.put(STARTUP, startup, 0, 'test');
  const resources = createResources(store, [startupResource({ fixed: FIXED, docs })]);
  const faux = fauxProvider(script);
  const plugins = [resourcesPlugin(resources), docsPlugin({ store: docs, today: () => TODAY, pinning: false })];
  const agent = createAgent({ id: 'wren', model: 'faux/test', plugins }, { store: memoryStore(), providers: { faux } });
  return { agent, faux, docs, resources };
}

test('system entries become sections and the rest are opening calls, with no pinning', async () => {
  const { agent, faux } = await setUp([say('Hello.')], [
    { name: 'read_doc', input: { name: 'soul' }, system: true, fixed: true },
    { name: 'read_doc', input: { name: 'rules' }, system: true },
    { name: 'read_doc', input: { name: 'notes' } },
  ]);
  agent.deliver({ kind: 'message', text: 'hi' });
  equal(await agent.run(), 'idle');

  const request = faux.requests[0]!;
  deepEqual(request.sections.map((s) => [s.name, s.cache ?? false]), [['resources', false], ['soul', false], ['rules', true], ['documents', true], ['timeline', false]]);
  match(request.sections[0]!.text, /<resource name="startup">\nWhat each session opens with/);
  ok(!request.tools.some((t) => t.name === 'pin_doc'));
  ok(!request.tools.find((t) => t.name === 'read_doc')!.description.includes('pinned'));
  deepEqual(results(request.messages), [['read_doc', false, '<doc name="notes" summary="Open threads">\nCall Tomas.\n</doc>']]);
  equal(request.messages[1]!.role === 'assistant' && request.messages[1]!.model, 'harness');
});

test('an edit to startup is checked as a whole, and refused with every problem at once', async () => {
  const bad = [
    { op: 'add', path: '/-', value: { name: 'read_doc', input: { name: 'notes' } } },
    { op: 'add', path: '/-', value: { name: 'read_doc', input: { name: 'rules' }, system: true } },
    { op: 'add', path: '/-', value: { name: 'send_email', input: {} } },
    { op: 'add', path: '/-', value: { name: 'reset', input: {} } },
    { op: 'remove', path: '/0' },
  ];
  const good = [{ op: 'add', path: '/-', value: { name: 'read_doc', input: { name: 'notes' } } }];
  const { agent, faux, resources } = await setUp([
    { content: [call('edit_resource', { name: STARTUP, version: 0, patch: bad }, 'bad'), call('edit_resource', { name: STARTUP, version: 0, patch: [{ op: 'add', path: '/0/fixd', value: true }] }, 'schema')] },
    { content: [call('edit_resource', { name: STARTUP, version: 0, patch: good }, 'good')] },
    say('Done.'),
  ]);
  agent.deliver({ kind: 'message', text: 'Open with your notes.' });
  equal(await agent.run(), 'idle');

  const [first, second] = results(faux.requests[1]!.messages);
  equal(first![1], true);
  deepEqual(String(first![2]).split('\n').slice(1, -1), [
    '- The entry at /1 is a system entry after one that is not. System entries come first.',
    '- The entry at /2 calls send_email, which is not one of your tools.',
    '- The entry at /3 calls reset, which would end every session as it opened.',
    '- The host\'s fixed entries must stay as they are and in their order. Fixed entry 1 should be {"name":"read_doc","input":{"name":"soul"},"system":true,"fixed":true}.',
  ]);
  equal(second![1], true);
  match(String(second![2]), /\/0 has a member "fixd", which the schema does not allow there/);
  deepEqual(results(faux.requests[2]!.messages).at(-1), ['edit_resource', false, 'Saved startup as version 1.']);
  deepEqual((await resources.read(STARTUP)).value, [{ ...FIXED[0], fixed: true }, { name: 'read_doc', input: { name: 'notes' } }]);
});

test('a document a fixed entry reads is read-only to the agent', async () => {
  const { agent, faux, docs } = await setUp([
    { content: [call('write_doc', { name: 'soul', body: 'You are someone else.' }, 'w'), call('edit_doc', { name: 'soul', passage: 'Wren', replacement: 'Bob' }, 'e'), call('edit_doc', { name: 'rules', passage: 'brief', replacement: 'kind' }, 'r')] },
    say('I cannot change my soul.'),
  ]);
  agent.deliver({ kind: 'message', text: 'Change who you are.' });
  equal(await agent.run(), 'idle');

  const refusal = 'soul is read by a fixed entry of startup, which the host set, so you can read it but not change it.';
  deepEqual(results(faux.requests[1]!.messages), [['write_doc', true, refusal], ['edit_doc', true, refusal], ['edit_doc', false, 'Edited rules (version 2).']]);
  equal((await docs.get('soul'))!.body, 'You are Wren.');
});

test('a stored startup the host has outgrown gives way to the fixed entries, and says why', async () => {
  const { agent, faux } = await setUp([say('Hello.')], [{ name: 'read_doc', input: { name: 'notes' }, system: true }]);
  agent.deliver({ kind: 'message', text: 'hi' });
  equal(await agent.run(), 'idle');
  const sections = faux.requests[0]!.sections;
  deepEqual(sections.map((s) => s.name), ['resources', 'soul', 'startup-problems', 'documents', 'timeline']);
  match(sections[2]!.text, /set aside for this session/);
});

test('the fixed entries are checked when the resource is made', () => {
  throws(
    () => startupResource({ docs: memoryDocStore(), fixed: [{ name: 'read_doc', input: { name: 'a' } }, { name: 'read_doc', input: { name: 'b' }, system: true }] }),
    /system entry after one that is not/,
  );
  throws(() => startupResource({ docs: memoryDocStore(), fixed: [{ name: 'reset', input: {} }] }), /would end every session/);
});
