// Folder modes at the plugin's boundary: what the agent sees, what its tools answer, and what lands in the store.
import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent, fauxProvider, memoryStore, type ScriptStep, type ToolCall } from '@flatbed/core';
import { afterWrite, docsPlugin, memoryDocStore, writeTarget, type DocStore, type Folder } from './index.ts';

const call = (name: string, input: Record<string, unknown>, id = name): ToolCall => ({ type: 'toolCall', id, name, input });
const say = (text: string): ScriptStep => ({ content: [{ type: 'text', text }] });

const FOLDERS: Folder[] = [
  { path: 'evidence', mode: 'read', about: 'The physical facts of the case.' },
  { path: 'holmes', mode: 'write', about: "Holmes's private notebook." },
  { path: 'solution', mode: 'sealed', about: 'What really happened.' },
];

async function seeded(): Promise<DocStore> {
  const docs = memoryDocStore();
  await docs.put({ name: 'evidence/boot', summary: 'A muddy boot', body: 'Clay from Surrey.', pinned: true, writtenBy: 'host' });
  await docs.put({ name: 'solution/culprit', summary: 'Who did it', body: 'The gardener.', pinned: true, writtenBy: 'host' });
  await docs.put({ name: 'soul', summary: 'Who you are', body: 'You are Holmes.', pinned: true, writtenBy: 'host' });
  return docs;
}

function agentWith(docs: DocStore, folders: DocsFolders, script: ScriptStep[]) {
  const faux = fauxProvider(script);
  const plugin = docsPlugin({ store: docs, folders, today: () => '2026-10-19' });
  const agent = createAgent({ id: 'holmes', model: 'faux/test', plugins: [plugin] }, { store: memoryStore(), providers: { faux } });
  return { agent, faux };
}
type DocsFolders = Parameters<typeof docsPlugin>[0]['folders'];

/** Every tool result the model saw in the request at `index`, as [name, isError, text]. */
function results(faux: ReturnType<typeof fauxProvider>, index: number) {
  return faux.requests[index]!.messages.flatMap((m) => (m.role === 'tool' ? [[m.name, m.isError, m.content[0]!.type === 'text' ? m.content[0]!.text : '']] : []));
}

test('the agent is told its folders, their modes and what each is for, and a sealed pinned document stays out', async () => {
  const { agent, faux } = agentWith(await seeded(), FOLDERS, [say('Hello.')]);
  agent.deliver({ kind: 'message', text: 'hi' });
  equal(await agent.run(), 'idle');
  const sections = faux.requests[0]!.sections;
  deepEqual(sections.map((s) => s.name), ['documents', 'folders', 'evidence/boot', 'soul', 'timeline']);
  const folders = sections[1]!.text;
  match(folders, /<folder path="evidence\/" mode="read">The physical facts of the case\.<\/folder>/);
  match(folders, /<folder path="solution\/" mode="sealed">What really happened\.<\/folder>/);
  match(folders, /- read: you can list and read/);
  ok(!folders.includes('- reviewed:'), 'only the modes in use are explained');
  ok(!sections.some((s) => s.text.includes('The gardener')));
});

test('a read folder can be listed and read, and refuses writes, edits and pins with the reason', async () => {
  const docs = await seeded();
  const { agent, faux } = agentWith(docs, FOLDERS, [
    {
      content: [
        call('read_doc', { name: 'evidence/boot' }),
        call('write_doc', { name: 'evidence/boot', body: 'Clay from Kent.' }),
        call('edit_doc', { name: 'evidence/boot', passage: 'Surrey', replacement: 'Kent' }),
        call('pin_doc', { name: 'evidence/boot', pinned: false }),
        call('write_doc', { name: 'holmes/boot', summary: 'On the boot', body: 'The clay is from Surrey.' }),
      ],
    },
    say('Done.'),
  ]);
  agent.deliver({ kind: 'message', text: 'go' });
  equal(await agent.run(), 'idle');
  const refusal = 'evidence/boot is in evidence/, which you can read but not change. You can write in holmes/.';
  deepEqual(results(faux, 1), [
    ['read_doc', false, '<doc name="evidence/boot" summary="A muddy boot">\nClay from Surrey.\n</doc>'],
    ['write_doc', true, refusal],
    ['edit_doc', true, refusal],
    ['pin_doc', true, refusal],
    ['write_doc', false, 'Created holmes/boot (version 1).'],
  ]);
  equal((await docs.history('evidence/boot')).length, 1);
});

test('a sealed folder is absent from listing and reading, and refuses writes', async () => {
  const docs = await seeded();
  const { agent, faux } = agentWith(docs, FOLDERS, [
    {
      content: [
        call('list_docs', {}),
        call('list_docs', { prefix: 'solution/' }, 'list2'),
        call('read_doc', { name: 'solution/culprit' }),
        call('write_doc', { name: 'solution/guess', summary: 'A guess', body: 'The butler.' }),
      ],
    },
    say('Done.'),
  ]);
  agent.deliver({ kind: 'message', text: 'go' });
  equal(await agent.run(), 'idle');
  const sealed = 'solution/ is sealed, so you cannot list, read or write in it until it is opened.';
  deepEqual(results(faux, 1), [
    ['list_docs', false, 'evidence/boot (pinned): A muddy boot\nsoul (pinned): Who you are'],
    ['list_docs', true, sealed],
    ['read_doc', true, sealed],
    ['write_doc', true, sealed],
  ]);
  equal(await docs.get('solution/guess'), undefined);
});

test('a folder the host unseals is open to the agent from its next session', async () => {
  const docs = await seeded();
  const unsealed = new Set<string>();
  const folders = () => FOLDERS.map((f): Folder => (unsealed.has(f.path) ? { ...f, mode: 'read' } : f));
  const { agent, faux } = agentWith(docs, folders, [
    { content: [call('reset', {})] },
    { content: [call('read_doc', { name: 'solution/culprit' })] },
    say('It was the gardener.'),
  ]);
  agent.deliver({ kind: 'message', text: 'Reveal it.' });
  equal(await agent.run(), 'reset');
  ok(!faux.requests[0]!.sections.some((s) => s.name === 'solution/culprit'));

  unsealed.add('solution');
  agent.deliver({ kind: 'message', text: 'Reveal it.' });
  equal(await agent.run(), 'idle');
  const next = faux.requests[1]!.sections;
  ok(next.some((s) => s.name === 'solution/culprit'), 'the pinned solution is now in the context');
  match(next.find((s) => s.name === 'folders')!.text, /<folder path="solution\/" mode="read">/);
  deepEqual(results(faux, 2), [['read_doc', false, '<doc name="solution/culprit" summary="Who did it">\nThe gardener.\n</doc>']]);
});

test('with no folders, a session opens as before', async () => {
  const { agent, faux } = agentWith(await seeded(), undefined, [say('Hi.')]);
  agent.deliver({ kind: 'message', text: 'hi' });
  await agent.run();
  deepEqual(faux.requests[0]!.sections.map((s) => s.name), ['documents', 'evidence/boot', 'solution/culprit', 'soul', 'timeline']);
});

test('afterWrite gives the whole document as a write or an edit would leave it', async () => {
  const docs = await seeded();
  equal(writeTarget({ name: 'edit_doc', input: { name: 'soul' } }), 'soul');
  equal(writeTarget({ name: 'read_doc', input: { name: 'soul' } }), undefined);
  deepEqual(await afterWrite(docs, { name: 'edit_doc', input: { name: 'soul', passage: 'Holmes', replacement: 'Sherlock Holmes' } }), {
    name: 'soul',
    summary: 'Who you are',
    body: 'You are Sherlock Holmes.',
  });
  deepEqual(await afterWrite(docs, { name: 'write_doc', input: { name: 'holmes/new', summary: 'New', body: 'Fresh.' } }), { name: 'holmes/new', summary: 'New', body: 'Fresh.' });
  equal(await afterWrite(docs, { name: 'edit_doc', input: { name: 'soul', passage: 'nowhere', replacement: 'x' } }), undefined);
});
