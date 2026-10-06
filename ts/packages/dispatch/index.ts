/**
 * The dispatch plugin: an agent hands a piece of work to a sub-agent and hears back. A sub-agent is
 * an ordinary flatbed agent, made fresh for each dispatch, whose first session's header links to
 * the dispatching session and entry. It works from its configured sections plus the brief, and
 * ends with the `report` tool.
 */
import { createAgent, escapeText, newEntryId, type Entry, type Event, type ParentLink, type Plugin, type Provider, type RunOutcome, type Section, type Store, type Tool, type ToolContext, type ToolResult } from '@flatbed/core';

/** A sub-agent the host configures. Its budget is its own `softLimit` and `hardLimit`. */
export type SubAgent = {
  name: string;
  /** When the dispatching agent should choose this sub-agent, in a sentence. */
  description: string;
  model: string;
  sections?: Section[];
  plugins?: Plugin[];
  softLimit?: number;
  hardLimit?: number;
  maxTokens?: number;
};

export type DispatchOptions = {
  /** The first is the default. */
  agents: [SubAgent, ...SubAgent[]];
  store: Store;
  providers: Record<string, Provider>;
  /** Called when a sub-agent that was not waited for has reported, so the host can run the dispatching agent again. */
  wake?(agentId: string): void | Promise<void>;
  /** How many levels of sub-agents may sit below the agent that has this plugin. 1, the default, means sub-agents cannot dispatch. */
  maxDepth?: number;
};

const REPORTED = 'reported';
const HOW: Record<RunOutcome, string> = { idle: 'finished', reset: 'reset its session', stopped: 'was stopped', error: 'hit an error' };
const START =
  'Work on your brief. When you are done, call report with your answer. Calling report is the only way your answer reaches the agent that dispatched you: it sees nothing else you write.';

export function dispatchPlugin(options: DispatchOptions): Plugin {
  const maxDepth = options.maxDepth ?? 1;
  const byName = new Map(options.agents.map((a) => [a.name, a]));

  const dispatchTool: Tool = {
    name: 'dispatch',
    description: [
      'Hand a piece of work to a sub-agent, which works on it alone and reports back. Write the brief so it stands on its own: the sub-agent sees nothing of this session.',
      'Set wait to false for work that takes a while; you will get a dispatch_result event when it reports. Sub-agents:',
      ...options.agents.map((a) => `- ${a.name}: ${a.description}`),
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'What to do, and what to report.' },
        agent: { type: 'string', enum: [...byName.keys()], description: `The sub-agent. Defaults to ${options.agents[0].name}.` },
        wait: { type: 'boolean', description: 'Wait for the report. Defaults to true.' },
      },
      required: ['brief'],
    },
    async run(input, ctx) {
      const brief = String(input.brief);
      const sub = byName.get(typeof input.agent === 'string' ? input.agent : options.agents[0].name);
      if (sub === undefined) return error(`No sub-agent named ${String(input.agent)}.`);

      // The sub-agent's first session links back to the assistant message that holds this call. It
      // is the last one: its results are appended only after every call in the turn has run.
      const call = ctx.session.entries.findLast((e) => e.type === 'message' && e.message.role === 'assistant')!;
      const parent: ParentLink = { session: ctx.session.header.id, reason: 'dispatch', entry: call.id, agent: ctx.agent.id };
      const id = `${ctx.agent.id}.${sub.name}-${newEntryId().slice(0, 4)}`;
      await ctx.append({ type: 'custom', plugin: 'dispatch', data: { agent: id, brief } });

      if (input.wait === false) {
        work(id, sub, brief, parent, undefined)
          .then((result) => finish(ctx, id, result))
          .catch((caught) => console.error(`dispatch: waking ${ctx.agent.id} failed:`, caught));
        return `Dispatched to ${id}. You will get a dispatch_result event when it reports.`;
      }
      // A stop reaches the sub-agent only while the dispatching run waits for it.
      const result = await work(id, sub, brief, parent, ctx.signal);
      return { content: [{ type: 'text', text: result.text }], isError: result.status !== REPORTED };
    },
  };

  /**
   * Runs a fresh sub-agent to the end of its first session. Never throws. Only a report is a
   * success: a sub-agent that ends any other way, by a reset or a stop, did not finish its brief.
   */
  async function work(id: string, sub: SubAgent, brief: string, parent: ParentLink, signal: AbortSignal | undefined) {
    let answer: string | undefined;
    const report: Tool = {
      name: 'report',
      description: 'Report your answer to the agent that dispatched you. This ends your work, so call it once, when you are done.',
      inputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      run(input, ctx) {
        answer = String(input.answer);
        ctx.requestReset(REPORTED);
        return 'Reported.';
      },
    };
    const own: Plugin = {
      name: 'sub-agent',
      context: () => ({ sections: [...(sub.sections ?? []), { name: 'brief', text: `<brief>\n${escapeText(brief)}\n</brief>` }], tools: [report] }),
    };
    const deeper = maxDepth > 1 ? [dispatchPlugin({ ...options, maxDepth: maxDepth - 1 })] : [];
    try {
      const agent = createAgent(
        { id, model: sub.model, plugins: [own, ...(sub.plugins ?? []), ...deeper], softLimit: sub.softLimit, hardLimit: sub.hardLimit, maxTokens: sub.maxTokens, parent },
        { store: options.store, providers: options.providers },
      );
      // A run needs something to answer, and the brief is a section, so the sub-agent is asked to start.
      agent.deliver({ kind: 'message', attrs: { from: 'dispatcher' }, text: START });
      const outcome = await agent.run(signal === undefined ? {} : { signal });
      if (answer !== undefined) return { status: REPORTED, text: answer };
      const session = await options.store.read(id, (await options.store.list(id)).at(-1)!);
      const last = lastText(session.entries);
      const ended = `The sub-agent ${id} ${HOW[outcome]} without calling report, so it gave no answer.`;
      if (last !== undefined) return { status: 'stopped', text: `${ended} Its last message said:\n\n${last}` };
      return { status: 'failed', text: ended };
    } catch (caught) {
      return { status: 'failed', text: `The sub-agent ${id} failed: ${caught instanceof Error ? caught.message : String(caught)}` };
    }
  }

  async function finish(ctx: ToolContext, id: string, result: { status: string; text: string }) {
    const event: Event = { kind: 'dispatch_result', attrs: { agent: id, status: result.status }, text: result.text };
    ctx.deliver(event);
    await options.wake?.(ctx.agent.id);
  }

  return { name: 'dispatch', context: () => ({ tools: [dispatchTool] }) };
}

const error = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** The text of the last assistant message that has any. */
function lastText(entries: Entry[]): string | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const text = entry.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    if (text !== '') return text;
  }
  return undefined;
}
