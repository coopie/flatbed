/**
 * The single-pass supervisor: one model call with the spec's verdict schema as structured output.
 *
 * `Supervise` is the shape every supervisor has, so a host can hold one without knowing how it
 * works. `singlePass` is the one built so far. A supervisor that is itself an agent, with tools to
 * read further, would be a second function returning `Supervise` (see README.md).
 */
import { renderMaterial, systemPrompt, type ToolCall } from './prompt.ts';
import { check } from './check.ts';
import { verdictSchema, type ItemVerdict, type Spec, type Verdict } from './spec.ts';
import type { AssistantMessage, Complete, Entry, Usage } from './types.ts';

export type SuperviseInput = {
	spec: Spec;
	/** The session's entries, header excluded, in file order. The supervisor reads their path. */
	entries: Entry[];
	/** The call under review. Leave it out to audit the session as a whole. */
	call?: ToolCall;
	/** The host's answers, by item id, for every item the spec marks `answeredBy: "host"`. */
	answers?: Record<string, ItemVerdict>;
	signal?: AbortSignal;
};

export type Supervise = (input: SuperviseInput) => Promise<Verdict>;

export type SinglePassOptions = {
	complete: Complete;
	/** The model name, without the provider prefix. */
	model: string;
	/** 8,192 unless set; a long checklist needs room for every analysis. */
	maxTokens?: number;
};

/** How many times the model is asked before the verdict is recorded as unavailable. */
const ASKS = 2;

const addUsage = (a: Usage, b: Usage): Usage => ({
	input: a.input + b.input,
	output: a.output + b.output,
	cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
	cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0)
});

const firstLine = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);

/** The model's answer as checked JSON, or why it is not one. */
function readAnswer(
	message: AssistantMessage,
	schema: object
): { items: Record<string, ItemVerdict>; summary: string } | { failed: string } {
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
	return answer as { items: Record<string, ItemVerdict>; summary: string };
}

export function singlePass(options: SinglePassOptions): Supervise {
	return async ({ spec, entries, call, answers = {}, signal }) => {
		const missing = spec.checklist.filter((item) => item.answeredBy === 'host' && !(item.id in answers));
		if (missing.length > 0) {
			// A host that forgot an answer is a bug in the host, not a verdict to record.
			throw new Error(`The host must answer ${missing.map((item) => item.id).join(', ')} for ${spec.id}.`);
		}
		const schema = verdictSchema(spec);
		const request = {
			model: options.model,
			sections: [{ name: 'supervisor', text: systemPrompt(spec, call !== undefined), cache: true }],
			tools: [],
			messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: renderMaterial(entries, call) }] }],
			maxTokens: options.maxTokens ?? 8192,
			outputSchema: schema,
			...(signal === undefined ? {} : { signal })
		};

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
			// In the spec's order, whoever answered, so every reader sees the items the same way.
			const items: Record<string, ItemVerdict> = {};
			for (const item of spec.checklist) items[item.id] = (answers[item.id] ?? answer.items[item.id])!;
			return { status: 'given', spec: spec.id, items, summary: answer.summary, model, usage };
		}
		return { status: 'unavailable', spec: spec.id, reason: failed, model, usage };
	};
}
