/**
 * The TypeScript conformance runner. Runs every scenario in conformance/scenarios/ against the
 * memory store and the faux provider, as docs/spec/conformance.md describes, and prints `ok <name>`
 * or `FAIL <name>: <first difference>` for each. Run it with `node ts/packages/core/conformance.ts`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAgent } from './loop.ts';
import { pathOf } from './render.ts';
import { fauxProvider, type ScriptStep } from './providers/faux.ts';
import { memoryStore, newEntryId, newSessionId } from './store.ts';
import type { AgentConfig, Entry, EntryBody, Event, ParentLink, Plugin, Section, Tool, ToolContext, ToolDefinition, ToolResult } from './types.ts';

const SCENARIOS = fileURLToPath(new URL('../../../conformance/scenarios/', import.meta.url));
const AGENT = 'test';

/** What a tool does, after waiting `sleep` milliseconds and appending a custom entry with `append`'s data, when given. */
type Behaviour = { sleep?: number; append?: unknown } & (
  | { echo: string } | { text: string } | { error: string } | { reset: string } | { deliver: Event } | { waitForStop: string }
  | { runTools: { name: string; input: Record<string, unknown> }[] }
);
type Step =
  | { deliver: Event }
  | { run: { stop?: string; stopAfter?: number }; expect?: string | { error: string } }
  | { crash: EntryBody }
  | { rewind: number }
  | { header: Record<string, never> };

/** What the test plugin does beyond giving sections and tools, as docs/spec/conformance.md describes. */
type HookResult = ToolResult | { throw: string };
type PluginHooks = {
  context?: { append: unknown } | { throw: string };
  beforeTool?: Record<string, HookResult>;
  afterTool?: Record<string, HookResult>;
  onEntry?: { custom: unknown } | { throw: string };
  onSessionEnd?: { deliver: Event };
};

type Scenario = {
  name: string;
  agent: Omit<AgentConfig, 'id' | 'plugins'>;
  sections?: Section[];
  tools?: (ToolDefinition & { behaviour: Behaviour })[];
  plugin?: PluginHooks;
  script: (ScriptStep | { abort: string } | { hang: true })[];
  steps: Step[];
  expect: { sessions: unknown[][]; requests?: unknown[]; maxRunning?: number };
};

/** A scenario that takes longer than this fails, so that a hung run cannot hang the suite. */
const TIMEOUT_MS = 10_000;
/** The keys of a request that `expect.requests` may compare, when an item is an object. */
const REQUEST_KEYS = ['messages', 'sections', 'tools', 'maxTokens', 'effort'] as const;

/** How many tool calls are running now, and the most there have been at once. */
type Running = { now: number; most: number };

function toolFor({ behaviour, ...definition }: ToolDefinition & { behaviour: Behaviour }, running: Running): Tool {
  return {
    ...definition,
    async run(input, ctx) {
      running.most = Math.max(running.most, ++running.now);
      try {
        return await behave(behaviour, input, ctx, running);
      } finally {
        running.now--;
      }
    },
  };
}

async function behave(behaviour: Behaviour, input: Record<string, unknown>, ctx: ToolContext, running: Running): Promise<string> {
  if (behaviour.sleep !== undefined) await new Promise((resolve) => setTimeout(resolve, behaviour.sleep));
  if (behaviour.append !== undefined) await ctx.append({ type: 'custom', plugin: 'test', data: behaviour.append });
  if ('echo' in behaviour) return String(input[behaviour.echo]);
  if ('waitForStop' in behaviour) {
    if (!ctx.signal.aborted) await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    return behaviour.waitForStop;
  }
  if ('runTools' in behaviour) {
    // The tool gives up its place while its calls run, so it does not count as running then.
    running.now--;
    const results = await Promise.all(behaviour.runTools.map(({ name, input }, i) => ctx.runTool({ type: 'toolCall', id: `nested-${i}`, name, input })));
    running.most = Math.max(running.most, ++running.now);
    return results.map((r) => r.content.map((b) => (b.type === 'text' ? b.text : '')).join('')).join('\n');
  }
  if ('text' in behaviour) return behaviour.text;
  if ('error' in behaviour) throw new Error(behaviour.error);
  if ('reset' in behaviour) {
    ctx.requestReset(behaviour.reset);
    return 'Session will reset after this turn.';
  }
  ctx.deliver(behaviour.deliver);
  return 'Delivered.';
}

/** A hook's result, or the error `{"throw": "<message>"}` asks it to throw. */
function hookResult(result: HookResult | undefined): ToolResult | undefined {
  if (result !== undefined && 'throw' in result) throw new Error(result.throw);
  return result;
}

function testPlugin(scenario: Scenario, running: Running): Plugin {
  const hooks = scenario.plugin ?? {};
  return {
    name: 'test',
    async context(ctx) {
      if (hooks.context !== undefined && 'throw' in hooks.context) throw new Error(hooks.context.throw);
      // `append` fails here, and the hook carries on.
      if (hooks.context !== undefined) await ctx.append({ type: 'custom', plugin: 'test', data: hooks.context.append }).catch(() => {});
      return { sections: scenario.sections ?? [], tools: (scenario.tools ?? []).map((tool) => toolFor(tool, running)) };
    },
    beforeTool: (call) => hookResult(hooks.beforeTool?.[call.name]),
    afterTool: (call) => hookResult(hooks.afterTool?.[call.name]),
    async onEntry(entry, ctx) {
      if (hooks.onEntry === undefined || entry.type !== 'message' || entry.message.role !== 'tool') return;
      if ('throw' in hooks.onEntry) throw new Error(hooks.onEntry.throw);
      await ctx.append({ type: 'custom', plugin: 'test', data: hooks.onEntry.custom });
    },
    onSessionEnd(_session, ctx) {
      if (hooks.onSessionEnd) ctx.deliver(hooks.onSessionEnd.deliver);
    },
  };
}

async function runScenario(scenario: Scenario): Promise<string | undefined> {
  const store = memoryStore();
  let controller = new AbortController();
  // `{"abort": "<who>"}` sets the stop signal while the call is in flight, and the call fails.
  const script = scenario.script.map((step): ScriptStep => {
    // `{"hang": true}` never answers and ignores the signal.
    if ('hang' in step) return () => new Promise(() => {});
    if (!('abort' in step)) return step;
    return () => {
      controller.abort(step.abort);
      throw new Error('The request was cancelled.');
    };
  });
  const faux = fauxProvider(script);
  const running: Running = { now: 0, most: 0 };
  const plugin = testPlugin(scenario, running);
  const agent = createAgent({ id: AGENT, ...scenario.agent, plugins: [plugin] }, { store, providers: { faux } });
  const current = async () => store.read(AGENT, (await store.list(AGENT)).at(-1)!);
  const rewoundTo = new Set<string>();
  let rewind: string | undefined;

  for (const [i, step] of scenario.steps.entries()) {
    if ('deliver' in step) {
      agent.deliver(step.deliver, rewind === undefined ? {} : { parentId: rewind });
      rewind = undefined;
    } else if ('run' in step) {
      const stop = new AbortController();
      controller = stop;
      const { stop: who, stopAfter } = step.run;
      const timer = who === undefined ? undefined : setTimeout(() => stop.abort(who), stopAfter ?? 0);
      if (who !== undefined && stopAfter === undefined) stop.abort(who);
      let outcome: string;
      try {
        outcome = await agent.run({ signal: stop.signal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (typeof step.expect === 'object' && message === step.expect.error) continue;
        return `step ${i}: run failed with ${JSON.stringify(message)}`;
      } finally {
        clearTimeout(timer);
      }
      const expected = typeof step.expect === 'object' ? `to fail with ${JSON.stringify(step.expect.error)}` : step.expect;
      if (step.expect !== undefined && outcome !== step.expect) return `step ${i}: run ended ${outcome}, expected ${expected}`;
    } else if ('crash' in step) {
      const session = await current();
      const entry = { id: newEntryId(), parentId: session.entries.at(-1)?.id ?? null, at: new Date().toISOString(), ...step.crash } as Entry;
      await store.append(AGENT, session.header.id, entry);
    } else if ('header' in step) {
      // Only the header of a new session, as a process that stopped before its context entry would leave.
      const previous = (await store.list(AGENT)).at(-1);
      const now = new Date();
      await store.create({
        type: 'session', version: 1, id: newSessionId(now, previous), agent: AGENT, createdAt: now.toISOString(),
        ...(previous === undefined ? {} : { parent: { session: previous, reason: 'reset' as const } }),
      });
    } else {
      const target = pathOf((await current()).entries)[step.rewind];
      if (target === undefined) return `step ${i}: no entry at index ${step.rewind} of the path`;
      rewind = target.id;
      rewoundTo.add(target.id);
    }
  }

  const ids = await store.list(AGENT);
  if (ids.length !== scenario.expect.sessions.length) return `expected ${scenario.expect.sessions.length} sessions, found ${ids.length}`;
  for (const [s, id] of ids.entries()) {
    const { header, entries } = await store.read(AGENT, id);
    const expected = [...scenario.expect.sessions[s]!];
    const first = expected[0] as { header?: { parent?: Partial<ParentLink> } };
    if (first.header !== undefined) {
      expected.shift();
      // A scenario cannot know the id of a session the loop made, so it may leave `session` out.
      const want = first.header.parent;
      const got = want !== undefined && !('session' in want) && header.parent !== undefined
        ? (({ session: _session, ...rest }) => rest)(header.parent) : header.parent;
      const difference = firstDifference(got, want, `sessions[${s}].header.parent`);
      if (difference) return difference;
    }
    for (const [e, entry] of entries.entries()) {
      const before = entries[e - 1]?.id ?? null;
      const rewound = entry.type === 'event' && entry.parentId !== null && rewoundTo.has(entry.parentId);
      if (entry.parentId !== before && !rewound) return `sessions[${s}][${e}]: parentId does not name the entry before it`;
    }
    const actual = entries.map(({ id: _id, parentId: _parentId, at: _at, ...rest }) => rest);
    const difference = firstDifference(JSON.parse(JSON.stringify(actual)), expected, `sessions[${s}]`);
    if (difference) return difference;
  }
  const { requests, maxRunning } = scenario.expect;
  if (requests !== undefined) {
    if (faux.requests.length !== requests.length) return `requests: received ${faux.requests.length}, expected ${requests.length}`;
    for (const [r, want] of requests.entries()) {
      // An item is the messages, or an object with any of REQUEST_KEYS, each compared.
      const got = faux.requests[r]! as Record<string, unknown>;
      const keys = Array.isArray(want) ? ['messages'] : Object.keys(want as object);
      for (const key of keys) {
        if (!(REQUEST_KEYS as readonly string[]).includes(key)) return `requests[${r}]: unknown key ${key}`;
        const expected = Array.isArray(want) ? want : (want as Record<string, unknown>)[key];
        const difference = firstDifference(JSON.parse(JSON.stringify(got[key] ?? null)), expected, `requests[${r}].${key}`);
        if (difference) return difference;
      }
    }
  }
  if (maxRunning !== undefined && running.most !== maxRunning) return `maxRunning: got ${running.most}, expected ${maxRunning}`;
  return undefined;
}

/** Where two JSON values first differ, or undefined when they are equal. */
function firstDifference(actual: unknown, expected: unknown, at: string): string | undefined {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
      if (i >= actual.length) return `${at}: missing ${JSON.stringify(expected[i])}`;
      if (i >= expected.length) return `${at}: unexpected ${JSON.stringify(actual[i])}`;
      const difference = firstDifference(actual[i], expected[i], `${at}[${i}]`);
      if (difference) return difference;
    }
    return undefined;
  }
  if (isObject(expected) && isObject(actual)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const difference = firstDifference(actual[key], expected[key], `${at}.${key}`);
      if (difference) return difference;
    }
    return undefined;
  }
  return actual === expected ? undefined : `${at}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const files = (await readdir(SCENARIOS)).filter((f) => f.endsWith('.json')).sort();
let failed = 0;
for (const file of files) {
  const scenario = JSON.parse(await readFile(`${SCENARIOS}${file}`, 'utf8')) as Scenario;
  let difference: string | undefined;
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<string>((resolve) => (timer = setTimeout(resolve, TIMEOUT_MS, `took longer than ${TIMEOUT_MS / 1000} seconds`)));
    difference = await Promise.race([runScenario(scenario), timeout]);
    clearTimeout(timer);
  } catch (error) {
    difference = `threw ${error instanceof Error ? error.message : String(error)}`;
  }
  if (difference === undefined) console.log(`ok ${scenario.name}`);
  else {
    failed++;
    console.log(`FAIL ${scenario.name}: ${difference}`);
  }
}
if (files.length === 0) {
  console.log('FAIL no scenarios found');
  failed++;
}
// Exit outright, since a scenario that timed out may have left a run waiting.
process.exit(failed > 0 ? 1 : 0);
