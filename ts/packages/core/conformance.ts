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
import type { Entry, EntryBody, Event, ParentLink, Plugin, Section, Tool, ToolDefinition, ToolResult } from './types.ts';

const SCENARIOS = fileURLToPath(new URL('../../../conformance/scenarios/', import.meta.url));
const AGENT = 'test';

type Behaviour = { echo: string } | { text: string } | { error: string } | { reset: string } | { deliver: Event };
type Step =
  | { deliver: Event }
  | { run: { stop?: string }; expect?: string }
  | { crash: EntryBody }
  | { rewind: number }
  | { header: Record<string, never> };

/** What the test plugin does beyond giving sections and tools, as docs/spec/conformance.md describes. */
type HookResult = ToolResult | { throw: string };
type PluginHooks = {
  beforeTool?: Record<string, HookResult>;
  afterTool?: Record<string, HookResult>;
  onEntry?: { custom: unknown };
  onSessionEnd?: { deliver: Event };
};

type Scenario = {
  name: string;
  agent: { model: string; softLimit?: number; hardLimit?: number; maxTokens?: number; parent?: ParentLink };
  sections?: Section[];
  tools?: (ToolDefinition & { behaviour: Behaviour })[];
  plugin?: PluginHooks;
  script: (ScriptStep | { abort: string })[];
  steps: Step[];
  expect: { sessions: unknown[][]; requests?: unknown[] };
};

function toolFor({ behaviour, ...definition }: ToolDefinition & { behaviour: Behaviour }): Tool {
  return {
    ...definition,
    run(input, ctx) {
      if ('echo' in behaviour) return String(input[behaviour.echo]);
      if ('text' in behaviour) return behaviour.text;
      if ('error' in behaviour) throw new Error(behaviour.error);
      if ('reset' in behaviour) {
        ctx.requestReset(behaviour.reset);
        return 'Session will reset after this turn.';
      }
      ctx.deliver(behaviour.deliver);
      return 'Delivered.';
    },
  };
}

/** A hook's result, or the error `{"throw": "<message>"}` asks it to throw. */
function hookResult(result: HookResult | undefined): ToolResult | undefined {
  if (result !== undefined && 'throw' in result) throw new Error(result.throw);
  return result;
}

function testPlugin(scenario: Scenario): Plugin {
  const hooks = scenario.plugin ?? {};
  return {
    name: 'test',
    context: () => ({ sections: scenario.sections ?? [], tools: (scenario.tools ?? []).map(toolFor) }),
    beforeTool: (call) => hookResult(hooks.beforeTool?.[call.name]),
    afterTool: (call) => hookResult(hooks.afterTool?.[call.name]),
    async onEntry(entry, ctx) {
      if (hooks.onEntry && entry.type === 'message' && entry.message.role === 'tool') {
        await ctx.append({ type: 'custom', plugin: 'test', data: hooks.onEntry.custom });
      }
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
    if (!('abort' in step)) return step;
    return () => {
      controller.abort(step.abort);
      throw new Error('The request was cancelled.');
    };
  });
  const faux = fauxProvider(script);
  const plugin = testPlugin(scenario);
  const agent = createAgent({ id: AGENT, ...scenario.agent, plugins: [plugin] }, { store, providers: { faux } });
  const current = async () => store.read(AGENT, (await store.list(AGENT)).at(-1)!);
  const rewoundTo = new Set<string>();
  let rewind: string | undefined;

  for (const [i, step] of scenario.steps.entries()) {
    if ('deliver' in step) {
      agent.deliver(step.deliver, rewind === undefined ? {} : { parentId: rewind });
      rewind = undefined;
    } else if ('run' in step) {
      controller = new AbortController();
      if (step.run.stop !== undefined) controller.abort(step.run.stop);
      const outcome = await agent.run({ signal: controller.signal });
      if (step.expect !== undefined && outcome !== step.expect) return `step ${i}: run ended ${outcome}, expected ${step.expect}`;
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
  if (scenario.expect.requests !== undefined) {
    const received = JSON.parse(JSON.stringify(faux.requests.map((r) => r.messages)));
    return firstDifference(received, scenario.expect.requests, 'requests');
  }
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
    difference = await runScenario(scenario);
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
process.exitCode = failed > 0 ? 1 : 0;
