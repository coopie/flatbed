/**
 * The agent supervisor: the check given to a flatbed agent, which may read further with tools
 * before it gives its verdict through `report_verdict`.
 *
 * Each check is a fresh agent with an id of its own, `<id>-<hex4>`, so its session can never mix
 * with another check's, even when two guards share a store. The core opens its one session: the
 * header's `parent` links to the session checked, the context holds the system prompt and then the
 * material, and a short event asks for the verdict.
 */
import {
  createAgent,
  newEntryId,
  type AssistantMessage,
  type Entry,
  type ParentLink,
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
  /** The start of each check's agent id, which adds a dash and four hex characters. `supervisor` unless set. */
  id?: string;
  /** Tools to read further, such as the checked agent's documents. */
  tools?: Tool[];
  maxTokens?: number;
};

export const REPORT_VERDICT = 'report_verdict';
const ASK = 'Answer the checklist for the material in your context, then call report_verdict.';

export function agentPass(options: AgentPassOptions): Supervise {
  const { store } = options;

  return async ({ spec, entries, agent: checked, session, call, answers = {}, signal }) => {
    checkHostAnswers(spec, answers);
    const schema = verdictSchema(spec);
    const agentId = `${options.id ?? 'supervisor'}-${newEntryId().slice(0, 4)}`;
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
    const sections = [
      { name: 'supervisor', text: systemPrompt(spec, call !== undefined, true) },
      // The material is already XML, escaped inside, so it goes in as a section, which the core leaves as it is.
      { name: 'material', text: renderMaterial(entries, call), cache: true }
    ];

    const head = entries.at(-1);
    const parent: ParentLink | undefined =
      session === undefined
        ? undefined
        : { session, reason: 'supervise', ...(checked === undefined ? {} : { agent: checked }), ...(head === undefined ? {} : { entry: head.id }) };
    const agent = createAgent(
      {
        id: agentId,
        model: options.model,
        plugins: [{ name: 'supervisor', context: () => ({ sections, tools }) }],
        ...(parent === undefined ? {} : { parent }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens })
      },
      { store, providers: options.providers }
    );
    agent.deliver({ kind: 'request', attrs: { from: 'host' }, text: ASK });
    const outcome = await agent.run(signal === undefined ? {} : { signal });

    const [sessionId] = await store.list(agentId);
    const { entries: written } = await store.read(agentId, sessionId!);
    const replies = written.flatMap((entry) =>
      entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message as AssistantMessage] : []
    );
    const usage = replies.reduce<Usage>((sum, message) => addUsage(sum, message.usage), { input: 0, output: 0 });
    const judged = {
      spec: spec.id,
      ...(call?.id === undefined ? {} : { callId: call.id }),
      supervisor: agentId,
      model: replies.at(-1)?.model ?? options.model,
      usage
    };
    if (reported !== undefined) {
      return { status: 'given', ...judged, items: mergeAnswers(spec, reported.items, answers), summary: reported.summary };
    }
    return { status: 'unavailable', ...judged, reason: whyUnavailable(outcome, written) };
  };
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
