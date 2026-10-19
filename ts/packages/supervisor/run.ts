/**
 * The single-pass supervisor: one model call with the spec's verdict schema as structured output.
 *
 * `Supervise` is the shape every supervisor has, so a host, or the guard plugin, can hold one
 * without knowing how it works. `singlePass` is one; `agentPass` in agent.ts is the other.
 */
import type { AssistantMessage, Entry, Provider, Usage } from '@flatbed/core';
import { check } from './check.ts';
import { renderMaterial, systemPrompt, type Reference, type ReviewedCall } from './prompt.ts';
import { checkHostAnswers, mergeAnswers, verdictSchema, type ItemVerdict, type Spec, type Verdict } from './spec.ts';

export type SuperviseInput = {
  spec: Spec;
  /** The session's entries, header excluded, in file order. The supervisor reads their path. */
  entries: Entry[];
  /** The id of the agent whose session it is. An agent supervisor names it in its own session's parent. */
  agent?: string;
  /** The id of the session the entries come from. An agent supervisor links its own session to it. */
  session?: string;
  /** The call under review. Leave it out to audit the session as a whole. */
  call?: ReviewedCall;
  /**
   * Material from the host for this check, such as a document as it would be after the call, or
   * documents the work must agree with. The supervisor reads it after the session.
   */
  references?: Reference[];
  /** The host's answers, by item id, for every item the spec marks `answeredBy: "host"`, and no other. */
  answers?: Record<string, ItemVerdict>;
  /** Stops the check, such as when the run that asked for it is stopped. The verdict is then unavailable. */
  signal?: AbortSignal;
};

export type Supervise = (input: SuperviseInput) => Promise<Verdict>;

/** One provider call, as docs/spec/providers.md describes it, such as `provider.complete`. */
export type Complete = Provider['complete'];

export type SinglePassOptions = {
  complete: Complete;
  /** The model name, without the provider prefix. */
  model: string;
  /** 8,192 unless set; a long checklist needs room for every analysis. */
  maxTokens?: number;
};

/** The model's answer to the verdict schema. */
export type Answer = { items: Record<string, ItemVerdict>; summary: string };

/** How many times the model is asked before the verdict is recorded as unavailable. */
const ASKS = 2;

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
  cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0)
});

export const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);

/** The model's answer as checked JSON, or why it is not one. */
function readAnswer(message: AssistantMessage, schema: object): Answer | { failed: string } {
  if (message.stop === 'maxTokens') return { failed: 'the answer ran out of tokens' };
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return { failed: `the answer is not JSON (stop ${message.stop})` };
  }
  const problems = check(schema, answer);
  if (problems.length > 0) return { failed: `the answer is off the schema: ${problems.join('; ')}` };
  return answer as Answer;
}

export function singlePass(options: SinglePassOptions): Supervise {
  return async ({ spec, entries, call, references, answers = {}, signal }) => {
    checkHostAnswers(spec, answers);
    const schema = verdictSchema(spec);
    const request = {
      model: options.model,
      sections: [{ name: 'supervisor', text: systemPrompt(spec, call !== undefined), cache: true }],
      tools: [],
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: renderMaterial(entries, call, references) }] }],
      maxTokens: options.maxTokens ?? 8192,
      outputSchema: schema as Record<string, unknown>,
      ...(signal === undefined ? {} : { signal })
    };
    const judged = { spec: spec.id, ...(call?.id === undefined ? {} : { callId: call.id }) };

    let usage: Usage = { input: 0, output: 0 };
    let model = options.model;
    let failed = '';
    for (let ask = 1; ask <= ASKS; ask += 1) {
      let message: AssistantMessage;
      try {
        message = await options.complete(request);
      } catch (error) {
        // The provider has already retried what can be retried, so this is the answer.
        failed = `the model could not be reached: ${firstLine(error)}`;
        break;
      }
      usage = addUsage(usage, message.usage);
      model = message.model;
      const answer = readAnswer(message, schema);
      if ('failed' in answer) {
        failed = answer.failed;
        continue;
      }
      const items = mergeAnswers(spec, answer.items, answers);
      return { status: 'given', ...judged, items, summary: answer.summary, model, usage };
    }
    return { status: 'unavailable', ...judged, reason: failed, model, usage };
  };
}
