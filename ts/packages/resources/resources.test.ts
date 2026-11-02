// Tests of resources at the plugin's boundary: what the agent reads, which edits land, and what a refusal says.
import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgent, fauxProvider, memoryStore, type Message, type ScriptStep, type ToolCall } from '@flatbed/core';
import { createResources, memoryResourceStore, resourcesPlugin, type Resource, type ResourceStore } from './index.ts';
import { fileResourceStore } from './node.ts';

type Wake = { cron: string; prompt: string; lastRun?: string };
type Schedule = Record<string, Wake>;

const call = (name: string, input: Record<string, unknown>, id = name): ToolCall => ({ type: 'toolCall', id, name, input });
const say = (text: string): ScriptStep => ({ content: [{ type: 'text', text }] });
const results = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === 'tool' ? [[m.isError, m.content[0]?.type === 'text' ? m.content[0].text : '']] : []));

/** A schedule keyed by id, with a field the host sets when an entry fires, and a rule the schema cannot say. */
function scheduleResource(changes: Schedule[] = []): Resource<Schedule> {
  return {
    name: 'schedule',
    guide: 'What wakes you, keyed by a short id you choose.',
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { cron: { type: 'string' }, prompt: { type: 'string', minLength: 1 }, lastRun: { type: 'string', readOnly: true } },
        required: ['cron', 'prompt'],
        additionalProperties: false,
      },
    },
    initial: { 'weekly-plan': { cron: '0 9 * * 1', prompt: 'Plan the week.' } },
    check(next) {
      const problems = Object.entries(next).flatMap(([id, w]) => (w.cron.trim().split(/\s+/).length === 5 ? [] : [`/${id}/cron needs five fields.`]));
      if (Object.keys(next).length > 3) problems.push('There can be at most three entries.');
      return problems;
    },
    views: { prompts: (value) => Object.fromEntries(Object.entries(value).map(([id, w]) => [id, w.prompt])) },
    onChange: ({ value }) => void changes.push(value),
  };
}

function setUp(script: ScriptStep[], store: ResourceStore = memoryResourceStore()) {
  const changes: Schedule[] = [];
  const resources = createResources(store, [scheduleResource(changes)]);
  const faux = fauxProvider(script);
  const agent = createAgent({ id: 'wren', model: 'faux/test', plugins: [resourcesPlugin(resources)] }, { store: memoryStore(), providers: { faux } });
  return { agent, faux, resources, changes };
}

async function run(agent: ReturnType<typeof setUp>['agent']) {
  agent.deliver({ kind: 'message', text: 'Change the schedule.' });
  equal(await agent.run(), 'idle');
}

test('a read shows the value as JSON with its version, and a patch that passes is saved as the next', async () => {
  const add = [{ op: 'add', path: '/dentist', value: { cron: '0 9 20 11 *', prompt: 'Dentist at 10.' } }, { op: 'replace', path: '/weekly-plan/prompt', value: 'Plan the week with Sam.' }];
  const { agent, faux, resources, changes } = setUp([
    { content: [call('read_resource', { name: 'schedule' })] },
    { content: [call('edit_resource', { name: 'schedule', version: 0, patch: add })] },
    say('Done.'),
  ]);
  await run(agent);

  match(faux.requests[0]!.sections[0]!.text, /<resource name="schedule" views="prompts">\nWhat wakes you/);
  deepEqual(results(faux.requests[1]!.messages), [[false, `schedule, version 0:\n${JSON.stringify({ 'weekly-plan': { cron: '0 9 * * 1', prompt: 'Plan the week.' } }, null, 2)}`]]);
  deepEqual(results(faux.requests[2]!.messages).at(-1), [false, 'Saved schedule as version 1.']);
  const saved = await resources.read('schedule');
  deepEqual(saved.value, { 'weekly-plan': { cron: '0 9 * * 1', prompt: 'Plan the week with Sam.' }, dentist: { cron: '0 9 20 11 *', prompt: 'Dentist at 10.' } });
  equal(saved.writtenBy, 'wren');
  deepEqual(changes, [saved.value]);
});

test('an edit that fails the schema, or whose patch cannot apply, is refused with every problem and saves nothing', async () => {
  const { agent, faux, resources } = setUp([
    {
      content: [
        call('edit_resource', { name: 'schedule', version: 0, patch: [{ op: 'add', path: '/dentist', value: { cron: 9, prompt: '', when: 'soon' } }] }, 'schema'),
        call('edit_resource', { name: 'schedule', version: 0, patch: [{ op: 'replace', path: '/weekly/prompt', value: 'x' }] }, 'path'),
      ],
    },
    say('I will fix them.'),
  ]);
  await run(agent);

  const [schema, path] = results(faux.requests[1]!.messages);
  deepEqual(String(schema![1]).split('\n'), [
    'Nothing was saved, and schedule is still version 0, because:',
    '- /dentist/cron: Instance type "number" is invalid. Expected "string".',
    '- /dentist/prompt: String is too short (0 < 1).',
    '- /dentist has a member "when", which the schema does not allow there.',
    'Fix every one and send the whole patch again, against version 0.',
  ]);
  match(String(path![1]), /Operation 1 \(replace \/weekly\/prompt\) failed, so none of the patch was applied\. The whole value has no member "weekly": its members are "weekly-plan"\./);
  equal((await resources.read('schedule')).version, 0);
});

test('a field the host owns is refused to the agent, and the host can set it', async () => {
  const { agent, faux, resources } = setUp([
    {
      content: [
        call('edit_resource', { name: 'schedule', version: 1, patch: [{ op: 'replace', path: '/weekly-plan/lastRun', value: 'never' }] }, 'change'),
        call('edit_resource', { name: 'schedule', version: 1, patch: [{ op: 'replace', path: '/weekly-plan', value: { cron: '0 9 * * 1', prompt: 'New.' } }] }, 'replace'),
      ],
    },
    { content: [call('edit_resource', { name: 'schedule', version: 1, patch: [{ op: 'remove', path: '/weekly-plan' }] }, 'remove')] },
    say('Done.'),
  ]);
  const host = await resources.edit('schedule', 0, [{ op: 'add', path: '/weekly-plan/lastRun', value: '2026-11-02T09:00' }], { by: 'host', host: true });
  ok('saved' in host);
  await run(agent);

  const [changed, replaced] = results(faux.requests[1]!.messages);
  match(String(changed![1]), /- \/weekly-plan\/lastRun belongs to the host, and this edit changes it\. Leave it as it is\./);
  match(String(replaced![1]), /- \/weekly-plan\/lastRun belongs to the host, and this edit removes it\. .*Replacing the object that holds it removes it too/);
  deepEqual(results(faux.requests[2]!.messages).at(-1), [false, 'Saved schedule as version 2.']);
  deepEqual((await resources.read('schedule')).value, {});
});

test('a check reports every problem at once, after the schema passes', async () => {
  const many = ['a', 'b', 'c'].map((id) => ({ op: 'add', path: `/${id}`, value: { cron: '0 9', prompt: id } }));
  const { agent, faux } = setUp([{ content: [call('edit_resource', { name: 'schedule', version: 0, patch: many })] }, say('Fixing.')]);
  await run(agent);
  deepEqual(String(results(faux.requests[1]!.messages)[0]![1]).split('\n').slice(1, -1), [
    '- /a/cron needs five fields.',
    '- /b/cron needs five fields.',
    '- /c/cron needs five fields.',
    '- There can be at most three entries.',
  ]);
});

test('an edit against an older version is refused with a reason to read again, in the file store too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resources-'));
  try {
    const patch = (prompt: string) => [{ op: 'replace', path: '/weekly-plan/prompt', value: prompt }];
    const { agent, faux, resources } = setUp([{ content: [call('edit_resource', { name: 'schedule', version: 0, patch: patch('Mine.') })] }, say('I will read it again.')], fileResourceStore(root));
    ok('saved' in (await resources.edit('schedule', 0, patch('The host was first.'), { by: 'host', host: true })));
    await run(agent);
    deepEqual(results(faux.requests[1]!.messages)[0], [true, 'Nothing was saved. schedule is at version 1, and this change was made against version 0. Read it again, and make your change against what is there now.']);
    equal((await fileResourceStore(root).history('schedule')).length, 1);
    equal(await fileResourceStore(root).put('schedule', {}, 0, 'host'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a view shows what it names, and an unknown view says which there are', async () => {
  const { agent, faux } = setUp([
    { content: [call('read_resource', { name: 'schedule', view: 'prompts' }, 'view'), call('read_resource', { name: 'schedule', view: 'cron' }, 'none')] },
    say('Done.'),
  ]);
  await run(agent);
  deepEqual(results(faux.requests[1]!.messages), [
    [false, 'schedule, view prompts, version 0:\n{\n  "weekly-plan": "Plan the week."\n}'],
    [true, 'schedule has no view named cron. Its views are prompts.'],
  ]);
});
