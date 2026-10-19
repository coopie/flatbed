// A reviewed folder: the docs plugin and the guard together, with the spec picked by the document a call writes.
// The docs package is imported by path, since the supervisor does not depend on it.
import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent, fauxProvider, memoryStore, type ScriptStep, type ToolCall } from '@flatbed/core';
import { afterWrite, docsPlugin, memoryDocStore, renderDoc, writeTarget } from '../docs/index.ts';
import { supervisorGuard, type GuardRecord, type Spec, type SuperviseInput, type Verdict } from './index.ts';

const call = (name: string, input: Record<string, unknown>, id = name): ToolCall => ({ type: 'toolCall', id, name, input });

const casebook: Spec = {
  id: 'casebook',
  task: "a chapter of Watson's account",
  preamble: 'You are checking that the account gives nothing away.',
  checklist: [{ id: 'no-spoilers', title: 'No spoilers', lookFor: 'The chapter names no culprit the reader has not been shown.', severity: 'block', guidance: 'Leave the culprit unnamed.' }],
};

test('a reviewed write is refused with what failed, then accepted after a redraft', async () => {
  const docs = memoryDocStore();
  await docs.put({ name: 'casebook/chapter-1', summary: 'The first chapter', body: 'We arrived at the house.', pinned: false, writtenBy: 'host' });
  await docs.put({ name: 'solution/culprit', summary: 'Who did it', body: 'The gardener.', pinned: false, writtenBy: 'host' });

  // The supervisor judges the chapter as it would read after the call, against the sealed solution.
  const seen: SuperviseInput[] = [];
  const supervise = async (input: SuperviseInput): Promise<Verdict> => {
    seen.push(input);
    const after = input.references?.find((r) => r.name === 'after this call')?.text ?? '';
    const spoils = after.includes('gardener');
    return { status: 'given', spec: input.spec.id, model: 'fake', usage: { input: 0, output: 0 }, items: { 'no-spoilers': { ok: !spoils, analysis: spoils ? 'The chapter names the gardener.' : 'Nobody is named.' } }, summary: '' };
  };
  const guard = supervisorGuard({
    mode: 'enforce',
    supervise,
    specs: (c) => (writeTarget(c)?.startsWith('casebook/') ? casebook : undefined),
    references: async (c) => {
      const after = await afterWrite(docs, c);
      const solution = await docs.get('solution/culprit');
      return [...(after ? [{ name: 'after this call', text: renderDoc(after) }] : []), { name: 'solution/culprit', text: solution!.body }];
    },
  });
  const plugin = docsPlugin({
    store: docs,
    today: () => '2026-10-19',
    folders: [
      { path: 'casebook', mode: 'reviewed', about: "Watson's account." },
      { path: 'solution', mode: 'sealed' },
    ],
  });
  const script: ScriptStep[] = [
    { content: [call('edit_doc', { name: 'casebook/chapter-1', passage: 'the house.', replacement: 'the house, where the gardener waited.' }, 'first')] },
    { content: [call('edit_doc', { name: 'casebook/chapter-1', passage: 'the house.', replacement: 'the house, where someone waited.' }, 'second')] },
    { content: [call('write_doc', { name: 'notes/plan', summary: 'Plan', body: 'Unreviewed.' })] },
    { content: [{ type: 'text', text: 'Done.' }] },
  ];
  const faux = fauxProvider(script);
  const agent = createAgent({ id: 'watson', model: 'faux/test', plugins: [plugin, guard] }, { store: memoryStore(), providers: { faux } });
  agent.deliver({ kind: 'message', text: 'Write on.' });
  equal(await agent.run(), 'idle');

  const results = faux.requests.at(-1)!.messages.flatMap((m) => (m.role === 'tool' ? [m] : []));
  const first = results[0]!.content[0]!;
  equal(results[0]!.isError, true);
  match(first.type === 'text' ? first.text : '', /The supervisor stopped this edit_doc call[\s\S]*<analysis>The chapter names the gardener\.<\/analysis>\n<guidance>Leave the culprit unnamed\.<\/guidance>/);
  deepEqual(results.slice(1).map((m) => [m.isError, m.content[0]!.type === 'text' ? m.content[0]!.text : '']), [
    [false, 'Edited casebook/chapter-1 (version 2).'],
    [false, 'Created notes/plan (version 1).'],
  ]);
  equal((await docs.get('casebook/chapter-1'))!.body, 'We arrived at the house, where someone waited.');

  // Only the two casebook writes were checked, each with the whole chapter after it and the solution.
  equal(seen.length, 2);
  match(seen[0]!.references![0]!.text, /^<doc name="casebook\/chapter-1" summary="The first chapter">\nWe arrived at the house, where the gardener waited\.\n<\/doc>$/);
  equal(seen[0]!.references![1]!.text, 'The gardener.');
  ok(seen.every((s) => s.call?.name === 'edit_doc'));
});

test('references reach the supervisor material after the session and before the call', async () => {
  const { renderMaterial } = await import('./prompt.ts');
  const text = renderMaterial([], { id: 'c1', name: 'write_doc', input: { name: 'x' } }, [{ name: 'evidence/boot', text: 'Clay </reference>' }]);
  match(text, /<\/session>\n\n<reference name="evidence\/boot">Clay &lt;\/reference&gt;<\/reference>\n\n<call tool="write_doc">/);
});

test('a guard with a spec for each tool name is unchanged, and ignores names on the prototype', async () => {
  const records: GuardRecord[] = [];
  const guard = supervisorGuard({ mode: 'shadow', specs: { send: casebook }, supervise: async () => { throw new Error('unused'); } });
  const ctx = { append: async (e: { data: unknown }) => void records.push(e.data as GuardRecord) } as never;
  equal(await guard.beforeTool!(call('toString', {}), ctx), undefined);
  equal(records.length, 0);
});
