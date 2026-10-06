/**
 * A supervisor spec, the verdict schema derived from it, and the verdict itself.
 *
 * A spec is data, described by spec.schema.json, so it can be written by hand or in any language.
 * The verdict schema is derived from the spec in a few lines of plain object building, so Python
 * and Rust can port `verdictSchema` line for line.
 */
import { readFileSync } from 'node:fs';
import { check } from './check.ts';
import type { Usage } from './types.ts';

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
 */
export type Verdict =
	| {
			status: 'given';
			spec: string;
			items: Record<string, ItemVerdict>;
			summary: string;
			model: string;
			usage: Usage;
	  }
	| { status: 'unavailable'; spec: string; reason: string; model: string; usage: Usage };

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
