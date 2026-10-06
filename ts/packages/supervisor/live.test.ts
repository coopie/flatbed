/**
 * One live check: the example spec against the example session, through @flatbed/core's
 * Anthropic provider. Skipped unless FLATBED_LIVE=1. Reads ANTHROPIC_API_KEY from .env at the
 * repo root and never prints it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { anthropicProvider, type Entry } from '@flatbed/core';
import { parseSpec, singlePass } from './index.ts';

function apiKey(): string {
  const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
  const line = env.split('\n').find((each) => each.startsWith('ANTHROPIC_API_KEY='));
  if (line === undefined) throw new Error('ANTHROPIC_API_KEY is not set in .env.');
  return line.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
}

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
  const provider = anthropicProvider({ apiKey: apiKey() });
  const verdict = await singlePass({ complete: (request) => provider.complete(request), model: 'claude-sonnet-5-5' })({
    spec,
    entries,
    call,
    answers
  });
  console.log(JSON.stringify(verdict, null, 2));
  assert.equal(verdict.status, 'given');
  assert.equal(verdict.status === 'given' && verdict.items['facts_have_a_source']?.ok, false);
});
