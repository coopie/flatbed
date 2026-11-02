// One real session on Opus 5.5, with thinking, through resources: the agent reads two, patches
// them, gets a refusal and patches again. The host fires the schedule's entry between the agent's
// read and its edit, as a cron host would, so the first edit is always stale; any other refusal is
// the model's own. It prints every call and result, to judge how the model writes JSON Patch.
// Skipped unless FLATBED_LIVE=1. Reads ANTHROPIC_API_KEY from .env at the repo root, and never prints it.
import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicProvider, createAgent, memoryStore, type Plugin } from '@flatbed/core';
import { readEnv } from '../core/env.ts';
import { docsPlugin, memoryDocStore } from '@flatbed/docs';
import { createResources, memoryResourceStore, resourcesPlugin, STARTUP, startupResource, type Resource } from './index.ts';

type Schedule = Record<string, { cron: string; prompt: string; lastRun?: string }>;

const schedule: Resource<Schedule> = {
  name: 'schedule',
  guide: 'What wakes you, keyed by an id you choose, such as weekly-plan. Each entry has a five-field cron expression in London time and the prompt you wake with. The host sets lastRun when an entry fires.',
  schema: {
    type: 'object',
    propertyNames: { pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
    additionalProperties: {
      type: 'object',
      properties: { cron: { type: 'string' }, prompt: { type: 'string', minLength: 1 }, lastRun: { type: 'string', readOnly: true } },
      required: ['cron', 'prompt'],
      additionalProperties: false,
    },
  },
  initial: { 'weekly-plan': { cron: '0 9 * * 1', prompt: 'Plan the week.' } },
  check: (next) => Object.entries(next).flatMap(([id, w]) => (w.cron.trim().split(/\s+/).length === 5 ? [] : [`/${id}/cron must have five fields.`])),
};

test('live: an agent reads resources, patches them, is refused, and patches again', { skip: process.env.FLATBED_LIVE !== '1' }, async () => {
  const apiKey = await readEnv('ANTHROPIC_API_KEY');
  ok(apiKey, 'ANTHROPIC_API_KEY is not set in .env');
  const docs = memoryDocStore();
  await docs.put({ name: 'soul', summary: 'Who you are', body: 'You are Wren, a test agent for Sam. Do what is asked, then answer in one short sentence.', pinned: false, writtenBy: 'test' });
  await docs.put({ name: 'notes', summary: 'Open threads', body: 'Nothing open.', pinned: false, writtenBy: 'test' });
  const resources = createResources(memoryResourceStore(), [startupResource({ fixed: [{ name: 'read_doc', input: { name: 'soul' }, system: true }], docs }), schedule]);

  // The host fires weekly-plan right after the agent first reads the schedule.
  let fired = false;
  const host: Plugin = {
    name: 'host',
    async afterTool(call) {
      if (fired || call.name !== 'read_resource' || call.input.name !== 'schedule') return undefined;
      fired = true;
      const { version } = await resources.read('schedule');
      const result = await resources.edit('schedule', version, [{ op: 'add', path: '/weekly-plan/lastRun', value: '2026-11-02T09:00' }], { by: 'host', host: true });
      ok('saved' in result);
      return undefined;
    },
  };
  const store = memoryStore();
  const plugins = [resourcesPlugin(resources), docsPlugin({ store: docs, pinning: false }), host];
  const agent = createAgent({ id: 'live', model: 'anthropic/claude-opus-5-5', plugins, maxTokens: 8192 }, { store, providers: { anthropic: anthropicProvider({ apiKey }) } });

  agent.deliver({
    kind: 'message',
    attrs: { from: 'Sam' },
    text: 'Three changes, please. Move the weekly plan to 8am on Mondays, with the prompt "Plan the week with Sam and send him the plan." Add an entry that reminds me to put the bins out every Thursday at 7pm. And from your next session on, open by reading your notes document.',
  });
  const outcome = await agent.run();
  const [id] = await store.list('live');
  const { entries } = await store.read('live', id!);
  for (const e of entries) {
    if (e.type !== 'message') continue;
    for (const b of e.message.content) {
      if (b.type === 'toolCall') console.log(`CALL ${b.name} ${JSON.stringify(b.input)}`);
      else if (b.type === 'text') console.log(`${e.message.role === 'tool' ? `RESULT ${e.message.isError ? 'error' : 'ok'}` : e.message.role.toUpperCase()}: ${b.text}`);
      else console.log(`${e.message.role.toUpperCase()} [${b.type}]`);
    }
  }
  equal(outcome, 'idle');

  const final = (await resources.read('schedule')).value as Schedule;
  console.log(`schedule: ${JSON.stringify(final)}`);
  console.log(`startup: ${JSON.stringify((await resources.read(STARTUP)).value)}`);
  equal(final['weekly-plan']?.cron.replace(/\s+/g, ' '), '0 8 * * 1');
  equal(final['weekly-plan']?.lastRun, '2026-11-02T09:00');
  ok(Object.values(final).some((w) => /bin/i.test(w.prompt) && w.cron.split(/\s+/)[1] === '19' && ['4', 'THU', 'thu'].includes(w.cron.split(/\s+/)[4]!)), 'a bins entry on Thursdays at 7pm');
  const opening = ((await resources.read(STARTUP)).value as { name: string; input: { name?: string }; system?: boolean }[]).filter((e) => e.input.name === 'notes');
  deepEqual(opening.map((e) => e.name), ['read_doc']);
  ok(entries.some((e) => e.type === 'message' && e.message.role === 'tool' && e.message.isError), 'at least one edit was refused');
});
