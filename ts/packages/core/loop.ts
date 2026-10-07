/**
 * The loop: open or resume a session, ask the model, run the tools it calls, and append everything,
 * until nothing new needs an answer. docs/spec/loop.md is the contract; `run` below follows its
 * numbered steps in order.
 */
import { render, pathOf } from './render.ts';
import { newEntryId, newSessionId } from './store.ts';
import type {
  AgentConfig, AssistantMessage, Entry, EntryBody, Event, Plugin, PluginContext, Provider, RunOutcome,
  Session, Store, Tool, ToolCall, ToolContext, ToolResult,
} from './types.ts';

export const DEFAULT_SOFT_LIMIT = 120_000;
export const DEFAULT_HARD_LIMIT = 180_000;
export const DEFAULT_MAX_TOKENS = 8_192;
export const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
export const SOFT_LIMIT_NOTICE = 'This session is nearly full. Bring your notes up to date, then call reset.';

export const resetTool: Tool = {
  name: 'reset',
  description:
    'End this session and start a fresh one. Call it when your notes are up to date and the session is long, or when the work is finished. Anything not written down will be forgotten.',
  inputSchema: { type: 'object', properties: { reason: { type: 'string' } } },
  run(input, ctx) {
    ctx.requestReset(typeof input.reason === 'string' ? input.reason : undefined);
    return 'Session will reset after this turn.';
  },
};

export type Agent = {
  config: AgentConfig;
  /** Queues an event for the next delivery point. `parentId` appends it after an earlier entry, to rewind. */
  deliver(event: Event, options?: { parentId?: string }): void;
  /** Runs until nothing new needs an answer. Abort the signal with the stopper's name as its reason to stop. */
  run(options?: { signal?: AbortSignal }): Promise<RunOutcome>;
};

const notice = (text: string): EntryBody => ({ type: 'event', kind: 'notice', attrs: { from: 'harness' }, text });
const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const isSoftLimitNotice = (e: Entry) => e.type === 'event' && e.kind === 'notice' && e.attrs?.from === 'harness' && e.text === SOFT_LIMIT_NOTICE;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** A throwing hook is the plugin's bug: the call gets an error result, and no later hook runs for it. */
const pluginFailed = (plugin: Plugin, error: unknown) => errorResult(`The ${plugin.name} plugin failed: ${messageOf(error)}`);

export function createAgent(config: AgentConfig, deps: { store: Store; providers: Record<string, Provider> }): Agent {
  const { store } = deps;
  const plugins = config.plugins ?? [];
  const queue: { event: Event; parentId?: string }[] = [];
  let running = false;
  // The code for the open session's tools, kept between runs of this process.
  let cachedTools: { session: string; tools: Map<string, Tool> } | undefined;

  const providerName = config.model.slice(0, config.model.indexOf('/'));
  const provider = deps.providers[providerName];
  if (provider === undefined) throw new Error(`No provider named ${providerName} for model ${config.model}.`);

  function contextFor(session: Session): PluginContext {
    return {
      agent: config,
      session,
      append: async (entry) => {
        // Events go through `deliver`, so that none lands between a call and its result.
        if (entry.type !== 'custom') throw new Error('A plugin may append only custom entries. Deliver events instead.');
        await append(session, entry);
      },
      deliver: (event) => void queue.push({ event }),
    };
  }

  async function append(session: Session, body: EntryBody, parentId = session.entries.at(-1)?.id ?? null): Promise<Entry> {
    if (session.entries.at(-1)?.type === 'reset') throw new Error('Nothing may follow a reset.');
    const ids = new Set(session.entries.map((e) => e.id));
    let id = newEntryId();
    while (ids.has(id)) id = newEntryId();
    const { type, ...rest } = body;
    const entry = { type, id, parentId, at: new Date().toISOString(), ...rest } as Entry;
    await store.append(config.id, session.header.id, entry);
    session.entries.push(entry);
    const ctx = contextFor(session);
    for (const plugin of plugins) await plugin.onEntry?.(entry, ctx);
    return entry;
  }

  /** Calls every plugin's `context` hook, and adds the core `reset` tool after their tools. */
  async function collectContext(session: Session) {
    const sections = [];
    const tools = new Map<string, Tool>();
    for (const plugin of plugins) {
      const added = await plugin.context?.(contextFor(session));
      sections.push(...(added?.sections ?? []));
      for (const tool of added?.tools ?? []) {
        if (tools.has(tool.name)) throw new Error(`Two tools are named ${tool.name}.`);
        tools.set(tool.name, tool);
      }
    }
    if (tools.has(resetTool.name)) throw new Error('A plugin may not add a tool named reset.');
    tools.set(resetTool.name, resetTool);
    return { sections, tools };
  }

  /**
   * Step 1: the agent's newest session, unless it ends in a reset; otherwise a new one. A newest
   * session that holds only its header, because a process stopped after writing it, is opened in place.
   */
  async function openSession(): Promise<{ session: Session; tools: Map<string, Tool> }> {
    const ids = await store.list(config.id);
    const newestId = ids.at(-1);
    const newest = newestId === undefined ? undefined : await store.read(config.id, newestId);
    if (newest !== undefined && newest.entries.length > 0 && newest.entries.at(-1)?.type !== 'reset') {
      if (cachedTools?.session === newest.header.id) return { session: newest, tools: cachedTools.tools };
      // Opened by an earlier process: ask the plugins again for their tools' code.
      const { tools } = await collectContext(newest);
      cachedTools = { session: newest.header.id, tools };
      return { session: newest, tools };
    }
    const headerOnly = newest !== undefined && newest.entries.length === 0;
    // The session before the one being opened, whose reset says why this one starts.
    const previous = !headerOnly ? newest : ids.length > 1 ? await store.read(config.id, ids.at(-2)!) : undefined;
    const last = previous?.entries.at(-1);
    const now = new Date();
    const header: Session['header'] = headerOnly ? newest.header : {
      type: 'session', version: 1, id: newSessionId(now, newestId), agent: config.id, createdAt: now.toISOString(),
      ...(newestId === undefined
        ? config.parent === undefined ? {} : { parent: config.parent }
        : { parent: { session: newestId, reason: 'reset' as const } }),
    };
    const session: Session = { header, entries: [] };
    const { sections, tools } = await collectContext(session);
    if (!headerOnly) await store.create(header);
    const definitions = [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    await append(session, { type: 'context', sections, tools: definitions });
    const reason = last?.type === 'reset' ? last.reason : undefined;
    const why = last?.type !== 'reset' ? 'Session started.' : reason ? `Session started after a reset: ${reason}` : 'Session started after a reset.';
    await append(session, notice(why));
    cachedTools = { session: header.id, tools };
    return { session, tools };
  }

  /** Step 2: gives every unanswered call of the last assistant message an error result. */
  async function repair(session: Session) {
    for (const call of unansweredCalls(pathOf(session.entries))) {
      const result = errorResult('The harness stopped before this tool ran.');
      await append(session, { type: 'message', message: { role: 'tool', callId: call.id, name: call.name, ...result } });
    }
  }

  async function deliverQueued(session: Session) {
    for (const { event, parentId } of queue.splice(0)) await append(session, { type: 'event', ...event }, rewindTarget(session, parentId));
  }

  /**
   * The parent for a delivered event. A rewind target must be in the open session and must leave no
   * call on its path without a result; otherwise the event goes at the head, as usual.
   */
  function rewindTarget(session: Session, parentId: string | undefined): string | null {
    const head = session.entries.at(-1)?.id ?? null;
    const at = session.entries.findIndex((e) => e.id === parentId);
    if (at === -1) return head;
    return unansweredCalls(pathOf(session.entries.slice(0, at + 1))).length === 0 ? parentId! : head;
  }

  /**
   * A session needs a run when the last entry on its path, ignoring `custom` and `context` entries,
   * is a `tool` message or an event that is not from the harness.
   */
  function needsRun(session: Session): boolean {
    const last = pathOf(session.entries).findLast((e) => e.type !== 'custom' && e.type !== 'context');
    if (last?.type === 'event') return last.attrs?.from !== 'harness';
    return last?.type === 'message' && last.message.role === 'tool';
  }

  /** Runs one call as docs/spec/plugins.md describes. Never throws for a tool's own failure. */
  async function runTool(call: ToolCall, tools: Map<string, Tool>, ctx: ToolContext): Promise<ToolResult> {
    const tool = tools.get(call.name);
    if (tool === undefined) return errorResult(`No tool named ${call.name}.`);
    const problem = checkInput(call.input, tool.inputSchema);
    if (problem !== undefined) return errorResult(`Invalid input for ${call.name}: ${problem}.`);
    let result: ToolResult | undefined;
    for (const plugin of plugins) {
      try {
        result = (await plugin.beforeTool?.(call, ctx)) ?? undefined;
      } catch (error) {
        return pluginFailed(plugin, error);
      }
      if (result !== undefined) break;
    }
    if (result === undefined) {
      try {
        const output = await tool.run(call.input, ctx);
        result = typeof output === 'string' ? { content: [{ type: 'text', text: output }], isError: false } : output;
      } catch (error) {
        result = errorResult(messageOf(error));
      }
    }
    for (const plugin of plugins) {
      try {
        result = (await plugin.afterTool?.(call, result, ctx)) ?? result;
      } catch (error) {
        return pluginFailed(plugin, error);
      }
    }
    return result;
  }

  async function endSession(session: Session, by: 'agent' | 'harness', reason: string | undefined): Promise<RunOutcome> {
    // An empty reason is no reason.
    await append(session, { type: 'reset', by, ...(reason ? { reason } : {}) });
    for (const plugin of plugins) await plugin.onSessionEnd?.(session, contextFor(session));
    return 'reset';
  }

  async function run(signal: AbortSignal | undefined): Promise<RunOutcome> {
    // Read from the store on every run, since the host may have appended to it meanwhile.
    const { session, tools } = await openSession();
    await repair(session);
    await deliverQueued(session);
    const softLimit = config.softLimit ?? DEFAULT_SOFT_LIMIT;
    const hardLimit = config.hardLimit ?? DEFAULT_HARD_LIMIT;
    // The frozen context decides which tools exist; the plugins only supply their code.
    const { context } = render(pathOf(session.entries));
    const frozen = new Map(context.tools.flatMap((t) => (tools.has(t.name) ? [[t.name, tools.get(t.name)!] as const] : [])));
    // After the soft-limit notice, the loop runs one more turn so that the model can answer it.
    let answerNotice = false;
    // Tools see the run's stop signal, or one that is never set when the host gave none.
    const toolSignal = signal ?? new AbortController().signal;
    // Calls run together, but no more than this many at once.
    const limit = limiter(config.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS);

    while (answerNotice || needsRun(session)) {
      answerNotice = false;
      if (signal?.aborted) return stopped(session, signal);

      const { messages } = render(pathOf(session.entries));
      let message: AssistantMessage;
      try {
        message = await provider!.complete({
          model: config.model.slice(providerName.length + 1),
          sections: context.sections,
          tools: context.tools,
          messages,
          maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(config.effort === undefined ? {} : { effort: config.effort }),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) return stopped(session, signal);
        const failed: AssistantMessage = { role: 'assistant', content: [], model: config.model, usage: { input: 0, output: 0 }, stop: 'error' };
        await append(session, { type: 'message', message: failed });
        await append(session, notice(`The model call failed: ${messageOf(error)}`));
        return 'error';
      }
      await append(session, { type: 'message', message });

      const resets: (string | undefined)[] = [];
      const ctx: ToolContext = { ...contextFor(session), requestReset: (reason) => void resets.push(reason), signal: toolSignal };
      const calls = toolCalls(message);
      // A response cut off by maxTokens may hold a call whose input is incomplete, so none of its calls run.
      const results = message.stop === 'maxTokens'
        ? calls.map(() => errorResult('The response was cut off before this call was complete.'))
        : await Promise.all(calls.map((call) => limit(() => runTool(call, frozen, ctx))));
      for (const [i, call] of calls.entries()) {
        await append(session, { type: 'message', message: { role: 'tool', callId: call.id, name: call.name, ...results[i]! } });
      }
      if (resets.length > 0) return endSession(session, 'agent', resets[0]);

      const { input, output, cacheRead = 0, cacheWrite = 0 } = message.usage;
      const size = input + output + cacheRead + cacheWrite;
      if (size > hardLimit) return endSession(session, 'harness', 'context budget');
      if (size > softLimit && !session.entries.some(isSoftLimitNotice)) {
        await append(session, notice(SOFT_LIMIT_NOTICE));
        answerNotice = true;
      }

      await deliverQueued(session);
    }
    return 'idle';
  }

  async function stopped(session: Session, signal: AbortSignal): Promise<RunOutcome> {
    const who = typeof signal.reason === 'string' ? signal.reason : 'the host';
    await append(session, notice(`Stopped by ${who}.`));
    return 'stopped';
  }

  return {
    config,
    deliver(event, options = {}) {
      queue.push({ event, ...options });
    },
    async run(options = {}) {
      if (running) throw new Error(`Agent ${config.id} is already running.`);
      running = true;
      try {
        return await run(options.signal);
      } finally {
        running = false;
      }
    },
  };
}

/** Runs the functions it is given, at most `size` at a time, in the order they were given. */
function limiter(size: number) {
  if (!(size >= 1)) throw new Error(`maxConcurrentTools must be at least 1, not ${size}.`);
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter, or give it back.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

function toolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === 'toolCall');
}

/** The calls of the last assistant message on a path that have no `tool` message after them. */
function unansweredCalls(path: Entry[]): ToolCall[] {
  const at = path.findLastIndex((e) => e.type === 'message' && e.message.role === 'assistant');
  const assistant = path[at];
  if (assistant?.type !== 'message' || assistant.message.role !== 'assistant') return [];
  const answered = new Set(path.slice(at + 1).flatMap((e) => (e.type === 'message' && e.message.role === 'tool' ? [e.message.callId] : [])));
  return toolCalls(assistant.message).filter((call) => !answered.has(call.id));
}

/** The least check the spec asks for: an object, with its required properties present. */
export function checkInput(input: unknown, schema: Record<string, unknown>): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'expected an object';
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const missing = required.find((name) => !(name in input));
  return missing === undefined ? undefined : `missing required property "${missing}"`;
}
