// Tests for the provider adapters' translation, which the conformance suite cannot reach.
import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicRequest, fromAnthropic } from './providers/anthropic.ts';
import { fromOpenai, openaiRequest } from './providers/openai.ts';
import type { ProviderRequest } from './types.ts';

const request: ProviderRequest = {
  model: 'some-model',
  maxTokens: 100,
  sections: [
    { name: 'soul', text: 'You are a test agent.', cache: true },
    { name: 'timeline', text: '<timeline>today</timeline>' },
  ],
  tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: '<message from="Sam">Hi</message>' }] },
    {
      role: 'assistant',
      model: 'anthropic/some-model',
      usage: { input: 1, output: 1 },
      stop: 'toolUse',
      content: [
        { type: 'thinking', text: 'mine', signature: 'sig', provider: 'anthropic' },
        { type: 'thinking', text: 'theirs', provider: 'openai' },
        { type: 'toolCall', id: 'c1', name: 'echo', input: { text: 'x' } },
      ],
    },
    { role: 'tool', callId: 'c1', name: 'echo', content: [{ type: 'text', text: 'x' }], isError: false },
    { role: 'user', content: [{ type: 'text', text: '<notice from="harness">Later.</notice>' }] },
    { role: 'assistant', model: 'anthropic/some-model', usage: { input: 0, output: 0 }, stop: 'error', content: [] },
  ],
  outputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

test('anthropic: sections, cache breakpoints, tool results and structured output', () => {
  const body = anthropicRequest(request);
  deepEqual(body.system, [
    { type: 'text', text: 'You are a test agent.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '<timeline>today</timeline>' },
  ]);
  deepEqual(body.tools, [{ name: 'echo', description: 'Echo.', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]);
  deepEqual(body.cache_control, { type: 'ephemeral' });
  deepEqual(body.output_config, { format: { type: 'json_schema', schema: request.outputSchema } });
  deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: '<message from="Sam">Hi</message>' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'mine', signature: 'sig' },
        { type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'x' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'x' }], is_error: false },
        { type: 'text', text: '<notice from="harness">Later.</notice>' },
      ],
    },
  ]);
});

test('anthropic: a response becomes an assistant message', () => {
  const message = fromAnthropic(
    {
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 't1', name: 'echo', input: { text: 'y' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
    },
    'some-model',
  );
  deepEqual(message, {
    role: 'assistant',
    model: 'anthropic/some-model',
    stop: 'toolUse',
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0 },
    content: [
      { type: 'thinking', text: 'hmm', signature: 's', provider: 'anthropic' },
      { type: 'text', text: 'Checking.' },
      { type: 'toolCall', id: 't1', name: 'echo', input: { text: 'y' } },
    ],
  });
});

test('anthropic: at most four cache breakpoints, keeping the earliest sections', () => {
  const sections = ['a', 'b', 'c', 'd'].map((name) => ({ name, text: name, cache: true }));
  const withTools = anthropicRequest({ ...request, sections, outputSchema: undefined });
  const marked = (body: Record<string, unknown>) =>
    (body.system as { text: string; cache_control?: unknown }[]).filter((b) => b.cache_control).map((b) => b.text);
  // The history and the tools take two, so two sections are left.
  deepEqual(marked(withTools), ['a', 'b']);
  deepEqual(marked(anthropicRequest({ ...request, sections, tools: [], outputSchema: undefined })), ['a', 'b', 'c']);
});

test('anthropic: empty text dropped, empty results filled, tool results first, effort sent', () => {
  const body = anthropicRequest({
    model: 'm',
    maxTokens: 10,
    effort: 'high',
    sections: [{ name: 'empty', text: '' }, { name: 'soul', text: 'Soul.' }],
    tools: [],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: '' }] },
      {
        role: 'assistant', model: 'anthropic/m', usage: { input: 1, output: 1 }, stop: 'toolUse',
        content: [{ type: 'text', text: '' }, { type: 'thinking', text: 't', provider: 'anthropic' }, { type: 'toolCall', id: 'c1', name: 'echo', input: {} }],
      },
      // An event that an older log has between the call and its result.
      { role: 'user', content: [{ type: 'text', text: '<message from="Sam">Hm</message>' }] },
      { role: 'tool', callId: 'c1', name: 'echo', content: [{ type: 'text', text: '' }], isError: false },
    ],
  });
  deepEqual(body.system, [{ type: 'text', text: 'Soul.' }]);
  deepEqual(body.output_config, { effort: 'high' });
  deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'tool_use', id: 'c1', name: 'echo', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: '(no output)' }], is_error: false },
        { type: 'text', text: '<message from="Sam">Hm</message>' },
      ],
    },
  ]);
});

test('anthropic: refusal is kept, unknown stop reasons end, a missing signature is left out', () => {
  const response = (stop_reason: string) => ({ content: [{ type: 'thinking', thinking: 'h' }], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });
  equal(fromAnthropic(response('refusal'), 'm').stop, 'refusal');
  equal(fromAnthropic(response('pause_turn'), 'm').stop, 'end');
  deepEqual(fromAnthropic(response('end_turn'), 'm').content, [{ type: 'thinking', text: 'h', provider: 'anthropic' }]);
});

test('openai: one system message, tool calls as functions, thinking dropped', () => {
  const body = openaiRequest(request);
  deepEqual(body.messages, [
    { role: 'system', content: 'You are a test agent.\n\n<timeline>today</timeline>' },
    { role: 'user', content: [{ type: 'text', text: '<message from="Sam">Hi</message>' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"x"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'x' },
    { role: 'user', content: [{ type: 'text', text: '<notice from="harness">Later.</notice>' }] },
  ]);
  equal((body.response_format as { type: string }).type, 'json_schema');
});

test('openai: a response becomes an assistant message, with cached tokens counted apart', () => {
  const message = fromOpenai(
    {
      choices: [{ message: { content: 'Hi.', tool_calls: [{ id: 'c2', function: { name: 'echo', arguments: '{"text":"z"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } },
    },
    'gpt-test',
  );
  deepEqual(message, {
    role: 'assistant',
    model: 'openai/gpt-test',
    stop: 'toolUse',
    usage: { input: 60, output: 7, cacheRead: 40 },
    content: [
      { type: 'text', text: 'Hi.' },
      { type: 'toolCall', id: 'c2', name: 'echo', input: { text: 'z' } },
    ],
  });
});

test('http: the backoff sleep ends when the stop signal is set', async () => {
  const { postJson } = await import('./providers/http.ts');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('busy', { status: 529 });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort('Sam'), 50);
    const started = Date.now();
    const outcome = await postJson('https://example.invalid', {}, {}, controller.signal).then(() => 'resolved', (reason) => reason);
    equal(outcome, 'Sam');
    equal(Date.now() - started < 900, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('http: retries 408 but not 400', async () => {
  const { postJson } = await import('./providers/http.ts');
  const realFetch = globalThis.fetch;
  const statuses = [408, 200, 400];
  let calls = 0;
  globalThis.fetch = async () => {
    const status = statuses[calls++]!;
    return status === 200 ? Response.json({ ok: true }) : new Response('no', { status });
  };
  try {
    deepEqual(await postJson('https://example.invalid', {}, {}), { ok: true });
    equal(calls, 2);
    const outcome = await postJson('https://example.invalid', {}, {}).then(() => 'resolved', (error: Error) => error.message);
    equal(outcome, 'HTTP 400: no');
    equal(calls, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});
