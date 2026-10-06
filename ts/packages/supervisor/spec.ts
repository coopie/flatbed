/**
 * A supervisor spec, the verdict schema derived from it, and the verdict itself.
 *
 * A spec is data, described by spec.schema.json, so it can be written by hand or in any language.
 * The verdict schema is derived from the spec in a few lines of plain object building, so Python
 * and Rust can port `verdictSchema` line for line.
 */
import { readFileSync } from 'node:fs';
import { check } from './check.ts';
import type { Usage } from '@flatbed/core';

export type Severity = 'block' | 'warn';

export type ChecklistItem = {
  id: string;
  title: string;
  lookFor: string;
  severity: Severity;
  guidance?: string;
  answeredBy?: 'model' | 'host';
};

export type Spec = {
  id: string;
  task: string;
  preamble: string;
  checklist: ChecklistItem[];
};

export type ItemVerdict = { analysis: string; ok: boolean };

/**
 * What a supervisor came back with. `given` answers every item of the spec, the model's and the
 * host's. `unavailable` answers nothing and says why: a verdict nobody gave is never a pass.
 * `callId` is the id of the tool call judged, when there was one. `supervisor` is the agent id of
 * the check's session, when an agent gave it.
 */
export type Verdict = { spec: string; callId?: string; supervisor?: string; model: string; usage: Usage } & (
  | { status: 'given'; items: Record<string, ItemVerdict>; summary: string }
  | { status: 'unavailable'; reason: string }
);

const specSchema: object = JSON.parse(
  readFileSync(new URL('./spec.schema.json', import.meta.url), 'utf8')
);

/** Reads a spec from outside, such as a JSON file, and throws with every problem when it is not one. */
export function parseSpec(value: unknown): Spec {
  const problems = check(specSchema, value);
  if (problems.length === 0) {
    const ids = (value as Spec).checklist.map((item) => item.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (repeated.length > 0) problems.push(`checklist: ids repeat: ${repeated.join(', ')}`);
  }
  if (problems.length > 0) throw new Error(`Not a supervisor spec: ${problems.join('; ')}`);
  return value as Spec;
}

/** The items the model answers, in the spec's order. */
export function modelItems(spec: Spec): ChecklistItem[] {
  return spec.checklist.filter((item) => item.answeredBy !== 'host');
}

/**
 * The JSON Schema the model's answer must match. `items` holds one property per item the model
 * answers, each with `analysis` before `ok`, so a model that writes in property order reasons
 * before it decides. `summary` comes last, after every item. Every property is required and no
 * other is allowed, which is what providers' structured output asks for.
 */
export function verdictSchema(spec: Spec): object {
  const items: Record<string, object> = {};
  for (const item of modelItems(spec)) {
    items[item.id] = {
      type: 'object',
      description: item.title,
      additionalProperties: false,
      required: ['analysis', 'ok'],
      properties: {
        analysis: {
          type: 'string',
          description: 'What you found and where, citing the material. Write it before you decide.'
        },
        ok: { type: 'boolean', description: 'True only when the check passes on what you can see.' }
      }
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'summary'],
    properties: {
      items: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(items),
        properties: items
      },
      summary: {
        type: 'string',
        description: 'Your verdict as a whole, in one or two sentences, for the person who reads it.'
      }
    }
  };
}

/** The items a given verdict failed, in the spec's order, with their severity and guidance. */
export function failures(
  spec: Spec,
  verdict: Verdict
): (ChecklistItem & ItemVerdict)[] {
  if (verdict.status !== 'given') return [];
  return spec.checklist.flatMap((item) => {
    const answer = verdict.items[item.id];
    return answer === undefined || answer.ok ? [] : [{ ...item, ...answer }];
  });
}

/**
 * Whether a host should stop what the verdict judged: true when the verdict is unavailable, or
 * when any `block` item failed. A `warn` item never blocks. Use this rather than `failures()` to
 * decide, so an unavailable verdict, which has no failures, is never taken for a pass.
 */
export function blocked(spec: Spec, verdict: Verdict): boolean {
  return verdict.status === 'unavailable' || failures(spec, verdict).some((item) => item.severity === 'block');
}

/**
 * Checks the host's answers against the spec: one for every `answeredBy: "host"` item, and none for
 * an item the model answers, so a host answer never silently replaces the model's. A mismatch is a
 * bug in the host, not a verdict to record, so it throws.
 */
export function checkHostAnswers(spec: Spec, answers: Record<string, ItemVerdict>): void {
  const missing = spec.checklist.filter((item) => item.answeredBy === 'host' && !(item.id in answers));
  if (missing.length > 0) {
    throw new Error(`The host must answer ${missing.map((item) => item.id).join(', ')} for ${spec.id}.`);
  }
  const hostIds = new Set(spec.checklist.filter((item) => item.answeredBy === 'host').map((item) => item.id));
  const extra = Object.keys(answers).filter((id) => !hostIds.has(id));
  if (extra.length > 0) {
    throw new Error(`The host may answer only items marked answeredBy "host"; ${spec.id} has ${extra.join(', ')} for the model or not at all.`);
  }
}

/** The items of a given verdict in the spec's order, whoever answered, so every reader sees them the same way. */
export function mergeAnswers(
  spec: Spec,
  modelAnswers: Record<string, ItemVerdict>,
  hostAnswers: Record<string, ItemVerdict>
): Record<string, ItemVerdict> {
  const items: Record<string, ItemVerdict> = {};
  for (const item of spec.checklist) {
    items[item.id] = (item.answeredBy === 'host' ? hostAnswers[item.id] : modelAnswers[item.id])!;
  }
  return items;
}
