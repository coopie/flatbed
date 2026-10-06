/**
 * The dispatch plugin: an agent hands a piece of work to a sub-agent and hears back. A sub-agent is
 * an ordinary flatbed agent, made fresh for each dispatch, whose first session's header links to
 * the dispatching session and entry. It works from its configured sections plus the brief, and
 * ends with the `report` tool.
 */
import { createAgent, newEntryId, type Entry, type Event, type Plugin, type Provider, type Section, type Store, type Tool, type ToolContext, type ToolResult } from '@flatbed/core';

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

      // The sub-agent's first session links back to the entry that holds this call.
      const parent = { session: ctx.session.header.id, reason: 'dispatch' as const, entry: ctx.session.entries.at(-1)!.id };
      const id = `${ctx.agent.id}.${sub.name}-${newEntryId().slice(0, 4)}`;
      await ctx.append({ type: 'custom', plugin: 'dispatch', data: { agent: id, brief } });

      if (input.wait === false) {
        work(id, sub, brief, parent)
          .then((result) => finish(ctx, id, result))
          .catch((caught) => console.error(`dispatch: waking ${ctx.agent.id} failed:`, caught));
        return `Dispatched to ${id}. You will get a dispatch_result event when it reports.`;
      }
      const result = await work(id, sub, brief, parent);
      return { content: [{ type: 'text', text: result.text }], isError: result.status === 'failed' };
    },
  };

  /** Runs a fresh sub-agent to the end of its first session. Never throws. */
  async function work(id: string, sub: SubAgent, brief: string, parent: { session: string; reason: 'dispatch'; entry: string }) {
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
      context: () => ({ sections: [...(sub.sections ?? []), { name: 'brief', text: `<brief>\n${escape(brief)}\n</brief>` }], tools: [report] }),
    };
    const deeper = maxDepth > 1 ? [dispatchPlugin({ ...options, maxDepth: maxDepth - 1 })] : [];
    // The store gives the sub-agent's first session its link to the dispatching session.
    const base = options.store;
    const store: Store = {
      list: (agent) => base.list(agent),
      read: (agent, session) => base.read(agent, session),
      append: (agent, session, entry) => base.append(agent, session, entry),
      create: (header) => base.create({ ...header, parent: header.parent ?? parent }),
    };
    try {
      const agent = createAgent(
        { id, model: sub.model, plugins: [own, ...(sub.plugins ?? []), ...deeper], softLimit: sub.softLimit, hardLimit: sub.hardLimit, maxTokens: sub.maxTokens },
        { store, providers: options.providers },
      );
      const outcome = await agent.run();
      if (answer !== undefined) return { status: REPORTED, text: answer };
      const session = await options.store.read(id, (await options.store.list(id)).at(-1)!);
      const last = lastText(session.entries);
      if (last !== undefined) return { status: 'stopped', text: last };
      return { status: 'failed', text: `The sub-agent ${id} stopped (${outcome}) without an answer.` };
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
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The text of the last assistant message that has any. */
function lastText(entries: Entry[]): string | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const text = entry.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    if (text !== '') return text;
  }
  return undefined;
}
