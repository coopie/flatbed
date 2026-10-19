/**
 * Records a template's example project: a real run with Haiku through a running playground Worker,
 * saved as recordings/<id>.json, which the site ships and shows read-only. Run `pnpm dev` in
 * another terminal first, then:
 *
 *   node scripts/record.ts <template> [--ask <answer>] [--reveal] [--shadow] [--prompts <n>] [--then <message>]... [--base http://127.0.0.1:8787]
 *
 * It sends the template's answer to `ask` when it has one, then its three prompts in turn. With
 * --reveal it opens the sealed folders before the last prompt. --shadow records the supervisor's
 * verdicts without refusing, for trying a new spec, --prompts sends only the first n prompts, and each --then adds a message after them.
 * It costs a few cents.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { anthropicProvider, memoryStore } from '@flatbed/core';
import { memoryDocStore } from '@flatbed/docs';
import { AGENT_ID, revealEvent, templateAgent } from '../src/lib/agent.ts';
import { snapshot } from '../src/lib/stores.ts';
import { parseTemplate } from '../src/lib/template.ts';
import { readTemplateFiles } from '../src/lib/template-files.ts';
import { visitorEvent } from '../src/lib/view.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { ask: { type: 'string' }, reveal: { type: 'boolean' }, shadow: { type: 'boolean' }, prompts: { type: 'string' }, then: { type: 'string', multiple: true }, base: { type: 'string', default: 'http://127.0.0.1:8787' } },
});
const id = positionals[0];
if (id === undefined) throw new Error('Name a template, such as: node scripts/record.ts press');
const template = parseTemplate(await readTemplateFiles(id));
if (template.ask !== null && values.ask === undefined) throw new Error(`${id} asks for "${template.ask.label}"; give it with --ask.`);

// Every model call, the supervisor's included, goes through this provider, so it counts them.
const base = anthropicProvider({ apiKey: 'held-by-the-worker', baseUrl: `${values.base}/api/complete` });
let calls = 0;
const provider: typeof base = { ...base, complete: (request) => (calls++, base.complete(request)) };
const store = memoryStore();
const docs = memoryDocStore();
const unsealed = new Set<string>();
const agent = templateAgent({
  template,
  store,
  docs,
  provider,
  unsealed: () => unsealed,
  reviewMode: values.shadow ? 'shadow' : 'enforce',
  fetchPage: (url) => fetch(`${values.base}/api/fetch?url=${encodeURIComponent(url)}`),
  onEntry: (entry) => {
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      for (const block of entry.message.content) if (block.type === 'toolCall') console.log(`  ${block.name} ${String(block.input.name ?? block.input.url ?? '')}`);
    }
    if (entry.type === 'custom' && entry.plugin === 'supervisor') console.log(`  supervisor: ${(entry.data as { refused: boolean }).refused ? 'refused' : 'passed'}`);
  },
});

const messages = [...(template.ask && values.ask ? [`${template.ask.label}: ${values.ask}`] : []), ...template.prompts.slice(0, values.prompts === undefined ? undefined : Number(values.prompts)), ...(values.then ?? [])];
for (const [i, message] of messages.entries()) {
  if (values.reveal && i === messages.length - 1) {
    for (const f of template.folders.filter((f) => f.mode === 'sealed')) {
      unsealed.add(f.path);
      agent.deliver(await revealEvent(template, docs, f.path));
    }
  }
  console.log(`> ${message}`);
  agent.deliver(visitorEvent(message));
  console.log(`  ${await agent.run()}`);
}
const snap = await snapshot(template.id, AGENT_ID, store, docs, [...unsealed]);
await writeFile(new URL(`../recordings/${template.id}.json`, import.meta.url), `${JSON.stringify(snap)}\n`);
console.log(`Saved recordings/${template.id}.json: ${snap.sessions.length} sessions, ${snap.docs.length} documents, ${calls} model calls.`);
