/**
 * The agent supervisor: the check given to a flatbed agent, which may read further with tools
 * before it gives its verdict through `report_verdict`.
 *
 * Each check is one session of the supervisor agent, stored like any other. The runner writes the
 * session's start itself, rather than delivering the material as an event, because the core
 * escapes an event's text and the material is already XML: the header links to the session
 * checked, the context holds the system prompt and the tools, and one user message holds the
 * material exactly as the single-pass supervisor sends it. A short event then asks for the
 * verdict, and the loop runs from there.
 *
 * Checks run one at a time for each runner, because the loop resumes an agent's newest session,
 * and two checks started together would share one.
 */
import {
  createAgent,
  newEntryId,
  newSessionId,
  type AssistantMessage,
  type Entry,
  type EntryBody,
  type Provider,
  type Store,
  type Tool,
  type Usage
} from '@flatbed/core';
import { check } from './check.ts';
import { renderMaterial, systemPrompt } from './prompt.ts';
import { addUsage, type Answer, type Supervise } from './run.ts';
import { checkHostAnswers, mergeAnswers, verdictSchema, type Verdict } from './spec.ts';

export type AgentPassOptions = {
  /** Where the supervisor's sessions are stored. */
  store: Store;
  providers: Record<string, Provider>;
  /** `<provider>/<model-name>`, such as `anthropic/claude-sonnet-5-5`. */
  model: string;
  /** The supervisor agent's id. `supervisor` unless set. */
  id?: string;
  /** Tools to read further, such as the checked agent's documents. */
  tools?: Tool[];
  maxTokens?: number;
};

export const REPORT_VERDICT = 'report_verdict';
const ASK = 'Answer the checklist for the material above, then call report_verdict.';

export function agentPass(options: AgentPassOptions): Supervise {
  const agentId = options.id ?? 'supervisor';
  const { store } = options;
  let previous: Promise<unknown> = Promise.resolve();

  return (input) => {
    const next = previous.then(() => checkOnce(input));
    previous = next.catch(() => undefined);
    return next;
  };

  async function checkOnce({ spec, entries, session, call, answers = {}, signal }: Parameters<Supervise>[0]): Promise<Verdict> {
    checkHostAnswers(spec, answers);
    const schema = verdictSchema(spec);
    let reported: Answer | undefined;

    const reportVerdict: Tool = {
      name: REPORT_VERDICT,
      description:
        'Report your verdict on the checklist. Call it once, when you have answered every item; it ends your work.',
      inputSchema: schema as Record<string, unknown>,
      run(input, ctx) {
        const problems = check(schema, input);
        if (problems.length > 0) {
          return { content: [{ type: 'text', text: `Your verdict is off the schema: ${problems.join('; ')}. Call ${REPORT_VERDICT} again.` }], isError: true };
        }
        reported = input as Answer;
        ctx.requestReset('verdict reported');
        return 'Verdict recorded.';
      }
    };
    const tools = [...(options.tools ?? []), reportVerdict];

    // The session's start, written as the loop would write it, but with the material as a user message.
    const ids = await store.list(agentId);
    const now = new Date();
    const head = entries.at(-1);
    const header = {
      type: 'session' as const,
      version: 1 as const,
      id: newSessionId(now, ids.at(-1)),
      agent: agentId,
      createdAt: now.toISOString(),
      ...(session === undefined
        ? {}
        : { parent: { session, reason: 'dispatch' as const, ...(head === undefined ? {} : { entry: head.id }) } })
    };
    await store.create(header);
    const bodies: EntryBody[] = [
      {
        type: 'context',
        sections: [{ name: 'supervisor', text: systemPrompt(spec, call !== undefined, true), cache: true }],
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: renderMaterial(entries, call) }] } }
    ];
    let parentId: string | null = null;
    for (const body of bodies) {
      const entry = { ...body, id: newEntryId(), parentId, at: new Date().toISOString() } as Entry;
      await store.append(agentId, header.id, entry);
      parentId = entry.id;
    }

    const agent = createAgent(
      {
        id: agentId,
        model: options.model,
        plugins: [{ name: 'supervisor', context: () => ({ tools }) }],
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens })
      },
      { store, providers: options.providers }
    );
    agent.deliver({ kind: 'request', attrs: { from: 'host' }, text: ASK });
    const outcome = await agent.run(signal === undefined ? {} : { signal });

    const { entries: written } = await store.read(agentId, header.id);
    const replies = written.flatMap((entry) =>
      entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message as AssistantMessage] : []
    );
    const usage = replies.reduce<Usage>((sum, message) => addUsage(sum, message.usage), { input: 0, output: 0 });
    const judged = {
      spec: spec.id,
      ...(call?.id === undefined ? {} : { callId: call.id }),
      model: replies.at(-1)?.model ?? options.model,
      usage
    };
    if (reported !== undefined) {
      return { status: 'given', ...judged, items: mergeAnswers(spec, reported.items, answers), summary: reported.summary };
    }
    return { status: 'unavailable', ...judged, reason: whyUnavailable(outcome, written) };
  }
}

/** Why the supervisor agent gave no verdict, from how its run ended and the notices in its session. */
function whyUnavailable(outcome: string, entries: Entry[]): string {
  const notice = entries.findLast((entry) => entry.type === 'event' && entry.kind === 'notice');
  const said = notice?.type === 'event' ? `: ${notice.text}` : '';
  if (outcome === 'error') return `the supervisor's run ended in an error${said}`;
  if (outcome === 'stopped') return `the supervisor was stopped${said}`;
  if (outcome === 'reset') return 'the supervisor ran out of context before it reported a verdict';
  return `the supervisor finished without calling ${REPORT_VERDICT}`;
}
