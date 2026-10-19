// The Worker's guards, driven through its fetch handler with a fake KV, a fake rate limiter and a
// stubbed upstream, so no test reaches Anthropic or the web.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import worker, { checkPageUrl, MAX_REQUEST_BYTES, MAX_TOKENS, MODEL, pageText, type Env } from './index.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setup(options: { spent?: number; budget?: string; limited?: boolean } = {}) {
  const kv = new Map<string, string>();
  const day = new Date().toISOString().slice(0, 10);
  if (options.spent !== undefined) kv.set(`spend:${day}`, String(options.spent));
  const waits: Promise<unknown>[] = [];
  const env = {
    ANTHROPIC_API_KEY: 'test-key',
    DAILY_BUDGET_USD: options.budget ?? '10',
    BUDGET: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) },
    LIMITER: { limit: async () => ({ success: !options.limited }) },
    ASSETS: { fetch: async () => new Response('static') },
  } as unknown as Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const call = async (path: string, init?: RequestInit) => {
    const response = await worker.fetch(new Request(`http://playground.test${path}`, init), env, ctx);
    await Promise.all(waits);
    return response;
  };
  return { kv, day, call };
}

/** Stubs the upstream API and records what it was sent. */
function stubAnthropic(usage = { input_tokens: 1000, output_tokens: 200 }) {
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage }), { status: 200 });
  }) as typeof fetch;
  return sent;
}

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const minimal = { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

test('a model call is forced to Haiku 4.5, with max_tokens capped and unknown fields dropped', async () => {
  const sent = stubAnthropic();
  const { call } = setup();
  const response = await call('/api/complete/v1/messages', post({ ...minimal, max_tokens: 64_000, thinking: { type: 'enabled' }, stream: true }));
  assert.equal(response.status, 200);
  assert.equal(sent[0]!.body.model, MODEL);
  assert.equal(sent[0]!.body.max_tokens, MAX_TOKENS);
  assert.equal('thinking' in sent[0]!.body, false);
  assert.equal('stream' in sent[0]!.body, false);
  assert.equal(sent[0]!.headers.get('x-api-key'), 'test-key');
});

test('server tools are refused, so a caller cannot use web search on the key', async () => {
  const sent = stubAnthropic();
  const { call } = setup();
  const response = await call('/api/complete/v1/messages', post({ ...minimal, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }));
  assert.equal(response.status, 400);
  assert.equal(sent.length, 0);
});

test('an oversized request is refused before it reaches Anthropic', async () => {
  const sent = stubAnthropic();
  const { call } = setup();
  const big = { ...minimal, messages: [{ role: 'user', content: 'x'.repeat(MAX_REQUEST_BYTES) }] };
  const response = await call('/api/complete/v1/messages', post(big));
  assert.equal(response.status, 413);
  assert.equal(sent.length, 0);
});

test('a rate-limited IP gets a 429', async () => {
  const sent = stubAnthropic();
  const { call } = setup({ limited: true });
  assert.equal((await call('/api/complete/v1/messages', post(minimal))).status, 429);
  assert.equal(sent.length, 0);
});

test('each call adds its cost to the day, and a spent budget makes the playground read-only', async () => {
  stubAnthropic({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
  const { call, kv, day } = setup({ budget: '7' });
  assert.equal((await call('/api/complete/v1/messages', post(minimal))).status, 200);
  assert.equal(kv.get(`spend:${day}`), String(6_000_000)); // $1 in, $5 out
  assert.deepEqual(await (await call('/api/status')).json(), { readOnly: false });
  assert.equal((await call('/api/complete/v1/messages', post(minimal))).status, 200);
  assert.deepEqual(await (await call('/api/status')).json(), { readOnly: true });
  const refused = await call('/api/complete/v1/messages', post(minimal));
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /read_only/);
});

test('page fetches accept only public http and https addresses', () => {
  assert.equal(checkPageUrl('https://example.com/about'), undefined);
  for (const bad of [
    'file:///etc/passwd', 'ftp://example.com', 'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.5/',
    'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://example.com:8080/',
    'http://intranet/', 'http://printer.local/', 'not a url', 'http://user:pw@example.com/',
  ]) {
    assert.notEqual(checkPageUrl(bad), undefined, bad);
  }
});

test('a page fetch returns text, and a redirect to a private address is refused', async () => {
  globalThis.fetch = (async (url: string) => {
    if (url === 'https://example.com/') return new Response('<title>Ex</title><script>x()</script><p>Hello &amp; welcome</p>', { headers: { 'content-type': 'text/html' } });
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
  }) as typeof fetch;
  const { call } = setup();
  const ok = await call(`/api/fetch?url=${encodeURIComponent('https://example.com/')}`);
  assert.deepEqual(await ok.json(), { url: 'https://example.com/', title: 'Ex', text: 'Hello & welcome' });
  const redirected = await call(`/api/fetch?url=${encodeURIComponent('https://example.com/go')}`);
  assert.equal(redirected.status, 400);
});

test('page text drops scripts and styles and keeps the words', () => {
  const { title, text } = pageText('<html><head><title> A  B </title><style>p{}</style></head><body><h1>One</h1><p>Two</p></body></html>');
  assert.equal(title, 'A B');
  assert.equal(text, 'One\nTwo');
});
