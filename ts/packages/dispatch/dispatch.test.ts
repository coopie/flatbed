import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent, fauxProvider, memoryStore, type Entry, type ScriptStep, type Session, type Store } from '@flatbed/core';
import { dispatchPlugin, type DispatchOptions } from './index.ts';

const call = (name: string, input: Record<string, unknown>): ScriptStep => ({ content: [{ type: 'toolCall', id: 'call_1', name, input }] });
const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const researcher = { name: 'researcher', description: 'Looks things up.', model: 'kid/test', sections: [{ name: 'soul', text: 'You look things up.' }] };

/** A parent agent with the dispatch plugin. The parent's model is `faux`, the sub-agent's `kid`. */
function setup(parentScript: ScriptStep[], childScript: ScriptStep[], options: Partial<DispatchOptions> = {}) {
  const store: Store = memoryStore();
  const kid = fauxProvider(childScript);
  const plugin = dispatchPlugin({ agents: [researcher], store, providers: { kid }, ...options });
  const parent = createAgent({ id: 'boss', model: 'faux/test', plugins: [plugin] }, { store, providers: { faux: fauxProvider(parentScript) } });
  const only = async (agent: string): Promise<Session> => store.read(agent, (await store.list(agent))[0]!);
  /** The sub-agent's id, from the custom entry the plugin keeps in the parent's session. */
  const childId = async () => ((await only('boss')).entries.find((e) => e.type === 'custom')! as { data: { agent: string } }).data.agent;
  parent.deliver({ kind: 'message', attrs: { from: 'Sam' }, text: 'Please look into it.' });
  return { store, kid, parent, only, childId };
}

const toolResults = (entries: Entry[]) => entries.flatMap((e) => (e.type === 'message' && e.message.role === 'tool' ? [e.message] : []));
const assistantEntry = (entries: Entry[]) => entries.find((e) => e.type === 'message' && e.message.role === 'assistant')!;

test('waiting: the dispatch tool returns the report, and the sub-agent links back to the call', async () => {
  const { parent, only, childId, kid } = setup(
    [call('dispatch', { brief: 'Find when the tide is high at Port Ness.' }), say('High tide is at 6.')],
    [call('report', { answer: 'High tide at Port Ness is at 6:10.' })],
  );
  assert.equal(await parent.run(), 'idle');

  const boss = await only('boss');
  assert.deepEqual(toolResults(boss.entries)[0]!.content, [{ type: 'text', text: 'High tide at Port Ness is at 6:10.' }]);

  const child = await only(await childId());
  assert.match(child.header.agent, /^boss\.researcher-[0-9a-f]{4}$/);
  assert.deepEqual(child.header.parent, { session: boss.header.id, reason: 'dispatch', entry: assistantEntry(boss.entries).id, agent: 'boss' });
  // The message that starts the sub-agent says that report is the only way back.
  assert.match(JSON.stringify(kid.requests[0]!.messages), /only way your answer reaches the agent that dispatched you/);
  assert.deepEqual(kid.requests[0]!.sections, [
    { name: 'soul', text: 'You look things up.' },
    { name: 'brief', text: '<brief>\nFind when the tide is high at Port Ness.\n</brief>' },
  ]);
  // At the default depth of 1, a sub-agent cannot dispatch.
  assert.deepEqual(kid.requests[0]!.tools.map((t) => t.name), ['report', 'reset']);
  assert.deepEqual(child.entries.at(-1), { ...child.entries.at(-1), type: 'reset', by: 'agent', reason: 'reported' });
});

test('waiting: a sub-agent that ends without reporting gives an error with its last text', async () => {
  const { parent, only, childId } = setup([call('dispatch', { brief: 'Find the tide.' }), say('Noted.')], [say('I could not find a tide table.')]);
  await parent.run();
  const [result] = toolResults((await only('boss')).entries);
  const id = await childId();
  assert.deepEqual(result!.content, [
    { type: 'text', text: `The sub-agent ${id} finished without calling report, so it gave no answer. Its last message said:\n\nI could not find a tide table.` },
  ]);
  assert.equal(result!.isError, true);
});

test('waiting: a sub-agent that resets without reporting gives an error', async () => {
  const { parent, only, childId } = setup([call('dispatch', { brief: 'Find the tide.' }), say('Noted.')], [call('reset', { reason: 'lost my way' })]);
  await parent.run();
  const [result] = toolResults((await only('boss')).entries);
  assert.deepEqual(result!.content, [{ type: 'text', text: `The sub-agent ${await childId()} reset its session without calling report, so it gave no answer.` }]);
  assert.equal(result!.isError, true);
});

test('not waiting: the tool returns at once, then the report arrives as an event and the host is woken', async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let woken!: (agentId: string) => void;
  const wake = new Promise<string>((resolve) => (woken = resolve));
  const { parent, only, childId } = setup(
    [
      call('dispatch', { brief: 'Find the tide.', wait: false }),
      say('I have asked the researcher.'),
      (request) => {
        const last = request.messages.at(-1)!;
        assert.match(JSON.stringify(last), /<dispatch_result agent=\\"boss.researcher-/);
        return say('The researcher says 6:10.');
      },
    ],
    // The sub-agent answers only once the parent's first run has ended.
    [async () => (await released, { content: [{ type: 'toolCall', id: 'call_1', name: 'report', input: { answer: 'High tide at 6:10.' } }] })],
    { wake: woken },
  );

  assert.equal(await parent.run(), 'idle');
  const id = await childId();
  assert.deepEqual(toolResults((await only('boss')).entries)[0]!.content, [
    { type: 'text', text: `Dispatched to ${id}. You will get a dispatch_result event when it reports.` },
  ]);
  release();
  assert.equal(await wake, 'boss');

  assert.equal(await parent.run(), 'idle');
  const event = (await only('boss')).entries.find((e) => e.type === 'event' && e.kind === 'dispatch_result');
  assert.ok(event?.type === 'event');
  assert.deepEqual({ kind: event.kind, attrs: event.attrs, text: event.text }, {
    kind: 'dispatch_result',
    attrs: { agent: id, status: 'reported' },
    text: 'High tide at 6:10.',
  });
  const child = await only(id);
  assert.equal(child.header.parent?.reason, 'dispatch');
});

test('a deeper limit lets a sub-agent dispatch in turn', async () => {
  const { parent, kid } = setup([call('dispatch', { brief: 'Find the tide.' }), say('Done.')], [call('report', { answer: '6:10.' })], { maxDepth: 2 });
  await parent.run();
  assert.deepEqual(kid.requests[0]!.tools.map((t) => t.name), ['report', 'dispatch', 'reset']);
});
