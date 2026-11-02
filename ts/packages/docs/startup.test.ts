// Tests of startup.json at the plugin's boundary: what a session opens with, and which writes land.
import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent, fauxProvider, memoryStore, type Message, type ScriptStep, type ToolCall } from '@flatbed/core';
import { docsPlugin, memoryDocStore, STARTUP_DOC, type StartupEntry } from './index.ts';

const TODAY = '2026-10-06';
const call = (name: string, input: Record<string, unknown>, id = name): ToolCall => ({ type: 'toolCall', id, name, input });
const say = (text: string): ScriptStep => ({ content: [{ type: 'text', text }] });
const FIXED: StartupEntry[] = [{ name: 'read_doc', input: { name: 'soul' }, system: true }];
const results = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === 'tool' ? [[m.name, m.isError, m.content[0]?.type === 'text' ? m.content[0].text : '']] : []));

async function setUp(script: ScriptStep[], startup: unknown[] = [...FIXED.map((e) => ({ ...e, fixed: true }))]) {
  const docs = memoryDocStore();
  await docs.put({ name: 'soul', summary: 'Who you are', body: 'You are Wren.', pinned: true, writtenBy: 'test' });
  await docs.put({ name: 'rules', summary: 'How you work', body: 'Be brief.', pinned: false, writtenBy: 'test' });
  await docs.put({ name: 'notes', summary: 'Open threads', body: 'Call Tomas.', pinned: false, writtenBy: 'test' });
  await docs.put({ name: STARTUP_DOC, summary: 'What a session opens with', body: JSON.stringify(startup), pinned: false, writtenBy: 'test' });
  const faux = fauxProvider(script);
  const plugin = docsPlugin({ store: docs, today: () => TODAY, startup: FIXED });
  const agent = createAgent({ id: 'wren', model: 'faux/test', plugins: [plugin] }, { store: memoryStore(), providers: { faux } });
  return { agent, faux, docs };
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
  deepEqual(request.sections.map((s) => [s.name, s.cache ?? false]), [['documents', false], ['soul', false], ['rules', true], ['timeline', false]]);
  match(request.sections[0]!.text, /startup\.json is a list of tool calls/);
  ok(!request.tools.some((t) => t.name === 'pin_doc'));
  deepEqual(results(request.messages), [['read_doc', false, '<doc name="notes" summary="Open threads">\nCall Tomas.\n</doc>']]);
  equal(request.messages[1]!.role === 'assistant' && request.messages[1]!.model, 'harness');
});

test('a write to startup.json is checked as a whole, and refused with every problem at once', async () => {
  const bad = JSON.stringify([
    { name: 'read_doc', input: { name: 'notes' } },
    { name: 'read_doc', input: { name: 'rules' }, system: true },
    { name: 'send_email', input: {} },
    { name: 'reset', input: {} },
  ]);
  const good = JSON.stringify([...FIXED.map((e) => ({ ...e, fixed: true })), { name: 'read_doc', input: { name: 'notes' } }]);
  const { agent, faux, docs } = await setUp([
    { content: [call('write_doc', { name: STARTUP_DOC, body: bad }, 'bad'), call('edit_doc', { name: STARTUP_DOC, passage: ']', replacement: '' }, 'broken')] },
    { content: [call('write_doc', { name: STARTUP_DOC, body: good }, 'good')] },
    say('Done.'),
  ]);
  agent.deliver({ kind: 'message', text: 'Open with your notes.' });
  equal(await agent.run(), 'idle');

  const [first, second] = results(faux.requests[1]!.messages);
  equal(first![1], true);
  const lines = String(first![2]).split('\n');
  deepEqual(lines.slice(1, -1), [
    '- Entry 2 is a system entry after one that is not. System entries come first.',
    '- Entry 3 calls send_email, which is not one of your tools.',
    '- Entry 4 calls reset, which would end every session as it opened.',
    '- The host\'s fixed entries must stay as they are and in their order. Fixed entry 1 should be {"name":"read_doc","input":{"name":"soul"},"system":true,"fixed":true}.',
  ]);
  equal(second![1], true);
  match(String(second![2]), /It is not valid JSON/);
  deepEqual(results(faux.requests[2]!.messages).at(-1), ['write_doc', false, `Rewrote ${STARTUP_DOC} (version 2).`]);
  equal((await docs.get(STARTUP_DOC))!.body, good);
});

test('a document a fixed entry reads is read-only to the agent', async () => {
  const { agent, faux, docs } = await setUp([
    { content: [call('write_doc', { name: 'soul', body: 'You are someone else.' }, 'w'), call('edit_doc', { name: 'soul', passage: 'Wren', replacement: 'Bob' }, 'e'), call('edit_doc', { name: 'rules', passage: 'brief', replacement: 'kind' }, 'r')] },
    say('I cannot change my soul.'),
  ]);
  agent.deliver({ kind: 'message', text: 'Change who you are.' });
  equal(await agent.run(), 'idle');

  const refusal = 'soul is read by a fixed entry of startup.json, which the host set, so you can read it but not change it.';
  deepEqual(results(faux.requests[1]!.messages), [['write_doc', true, refusal], ['edit_doc', true, refusal], ['edit_doc', false, 'Edited rules (version 2).']]);
  equal((await docs.get('soul'))!.body, 'You are Wren.');
});

test('a startup.json the host has outgrown gives way to the fixed entries, and says why', async () => {
  const { agent, faux } = await setUp([say('Hello.')], [{ name: 'read_doc', input: { name: 'notes' }, system: true }]);
  agent.deliver({ kind: 'message', text: 'hi' });
  equal(await agent.run(), 'idle');
  const sections = faux.requests[0]!.sections;
  deepEqual(sections.map((s) => s.name), ['documents', 'soul', 'startup-problems', 'timeline']);
  match(sections[2]!.text, /set aside for this session/);
});

test('the startup option is checked when the plugin is made', () => {
  let message = '';
  try {
    docsPlugin({ store: memoryDocStore(), startup: [{ name: 'read_doc', input: { name: 'a' } }, { name: 'read_doc', input: { name: 'b' }, system: true }] });
  } catch (error) {
    message = (error as Error).message;
  }
  match(message, /system entry after one that is not/);
});
