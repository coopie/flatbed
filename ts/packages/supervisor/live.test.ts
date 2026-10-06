/**
 * One live check: the example spec against the example session, through Anthropic's Messages
 * API. Skipped unless FLATBED_LIVE=1. Reads ANTHROPIC_API_KEY from .env at the repo root and
 * never prints it.
 *
 * The provider here is a stand-in, just enough of docs/spec/providers.md for one request. Use
 * @flatbed/core's Anthropic provider once it lands.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseSpec, singlePass, type AssistantMessage, type Complete, type Entry } from './index.ts';

function apiKey(): string {
	const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
	const line = env.split('\n').find((each) => each.startsWith('ANTHROPIC_API_KEY='));
	if (line === undefined) throw new Error('ANTHROPIC_API_KEY is not set in .env.');
	return line.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
}

/** Enough of the Anthropic provider for a supervisor: system sections, user text, structured output. */
const anthropic: Complete = async (request) => {
	const response = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01' },
		body: JSON.stringify({
			model: request.model,
			max_tokens: request.maxTokens,
			system: request.sections.map((section) => ({
				type: 'text',
				text: section.text,
				...(section.cache ? { cache_control: { type: 'ephemeral' } } : {})
			})),
			messages: request.messages.map((message) => ({ role: 'user', content: message.content })),
			output_config: { format: { type: 'json_schema', schema: request.outputSchema } }
		})
	});
	if (!response.ok) throw new Error(`Anthropic answered ${response.status}: ${await response.text()}`);
	const body = (await response.json()) as {
		model: string;
		content: { type: string; text?: string }[];
		usage: { input_tokens: number; output_tokens: number };
		stop_reason: string;
	};
	const stops: Record<string, AssistantMessage['stop']> = { end_turn: 'end', max_tokens: 'maxTokens', tool_use: 'toolUse' };
	return {
		role: 'assistant',
		content: body.content.flatMap((block) => (block.type === 'text' ? [{ type: 'text' as const, text: block.text ?? '' }] : [])),
		model: `anthropic/${body.model}`,
		usage: { input: body.usage.input_tokens, output: body.usage.output_tokens },
		stop: stops[body.stop_reason] ?? 'error'
	};
};

const read = (name: string) => readFileSync(new URL(`./examples/${name}`, import.meta.url), 'utf8');

test('a live supervisor fails an email that offers a booked time', { skip: process.env['FLATBED_LIVE'] !== '1' }, async () => {
	const spec = parseSpec(JSON.parse(read('send-email.json')));
	const entries: Entry[] = read('session.jsonl').trim().split('\n').slice(1).map((line) => JSON.parse(line));
	const call = {
		name: 'send_email',
		input: {
			to: 'wren@example.org',
			subject: 'Garden plans',
			body: 'Hi Wren, Thursday at 3pm works for me to go through the garden plans. Juno'
		}
	};
	const answers = { written: { ok: true, analysis: 'The email has an address, a subject and a body.' } };
	const verdict = await singlePass({ complete: anthropic, model: 'claude-sonnet-5-5' })({ spec, entries, call, answers });
	console.log(JSON.stringify(verdict, null, 2));
	assert.equal(verdict.status, 'given');
	assert.equal(verdict.status === 'given' && verdict.items['facts_have_a_source']?.ok, false);
});
