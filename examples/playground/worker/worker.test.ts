// The Worker's guards, driven through its fetch handler with the real budget Durable Object on a
// fake storage, a fake rate limiter and a stubbed upstream, so no test reaches Anthropic or the web.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import worker, { checkPageUrl, MAX_PAGE_BYTES, MAX_REQUEST_BYTES, MAX_TOKENS, MODEL, pageText, rateKey, type Env } from './api.ts';
import { Budget, type BudgetState } from './budget.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setup(options: { spent?: number; budget?: string | undefined; limited?: boolean } = {}) {
  const stored = new Map<string, unknown>();
  const day = new Date().toISOString().slice(0, 10);
  if (options.spent !== undefined) stored.set(`spend:${day}`, options.spent);
  const state: BudgetState = {
    storage: {
      get: async <T>(k: string) => stored.get(k) as T | undefined,
      // A real write takes a moment, which is when a read-modify-write would lose an update.
      put: async <T>(k: string, v: T) => void (await new Promise((r) => setTimeout(r, 1)), stored.set(k, v)),
      list: async <T>({ prefix }: { prefix: string }) => new Map([...stored].filter(([k]) => k.startsWith(prefix))) as Map<string, T>,
      delete: async (k: string) => stored.delete(k),
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const object = new Budget(state);
  const budgetCalls: string[] = [];
  const limiterKeys: string[] = [];
  const waits: Promise<unknown>[] = [];
  const env = {
    ANTHROPIC_API_KEY: 'test-key',
    DAILY_BUDGET_USD: 'budget' in options ? options.budget : '10',
    BUDGET: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (input: string, init?: RequestInit) => (budgetCalls.push(input), object.fetch(new Request(input, init))) }),
    },
    LIMITER: { limit: async ({ key }: { key: string }) => (limiterKeys.push(key), { success: !options.limited }) },
    ASSETS: { fetch: async () => new Response('static') },
  } as unknown as Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const call = async (path: string, init?: RequestInit & { ip?: string }) => {
    const headers = new Headers(init?.headers);
    if (init?.ip) headers.set('cf-connecting-ip', init.ip);
    const response = await worker.fetch(new Request(`http://playground.test${path}`, { ...init, headers }), env, ctx);
    await Promise.all(waits);
    return response;
  };
  const spent = () => stored.get(`spend:${day}`);
  return { spent, call, budgetCalls, limiterKeys };
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
  const { call, spent } = setup({ budget: '7' });
  assert.equal((await call('/api/complete/v1/messages', post(minimal))).status, 200);
  assert.equal(spent(), 6_000_000); // $1 in, $5 out
  assert.deepEqual(await (await call('/api/status')).json(), { readOnly: false });
  assert.equal((await call('/api/complete/v1/messages', post(minimal))).status, 200);
  assert.deepEqual(await (await call('/api/status')).json(), { readOnly: true });
  const refused = await call('/api/complete/v1/messages', post(minimal));
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /read_only/);
});

test('calls that arrive together each count, and stop at the cap', async () => {
  // Each call is reserved at about $0.005 for its 4,096 max_tokens, so a $0.05 budget holds nine at
  // once: a rush of forty is cut off there instead of every call seeing room under the cap, and
  // each call's real cost, $0.01, reaches the total.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached = 0;
  globalThis.fetch = (async () => {
    reached++;
    await gate;
    return new Response(JSON.stringify({ content: [], usage: { input_tokens: 5_000, output_tokens: 1_000 } }), { status: 200 });
  }) as typeof fetch;
  const { call, spent } = setup({ budget: '0.05' });
  const rush = Array.from({ length: 40 }, () => call('/api/complete/v1/messages', post({ ...minimal, max_tokens: 4096 })));
  await new Promise((r) => setTimeout(r, 50));
  release();
  const statuses = (await Promise.all(rush)).map((r) => r.status);
  const passed = statuses.filter((s) => s === 200).length;
  assert.equal(passed, reached);
  assert.equal(passed, 9);
  assert.equal(statuses.filter((s) => s === 403).length, 40 - passed);
  assert.equal(spent(), passed * 10_000);
});

test('a missing or malformed DAILY_BUDGET_USD keeps the playground read-only', async () => {
  for (const budget of [undefined, '', 'ten', '-5', '0', 'NaN', 'Infinity', '1e9']) {
    const sent = stubAnthropic();
    const { call } = setup({ budget });
    assert.deepEqual(await (await call('/api/status')).json(), { readOnly: true }, String(budget));
    assert.equal((await call('/api/complete/v1/messages', post(minimal))).status, 403, String(budget));
    assert.equal(sent.length, 0);
  }
});

test('image and document blocks are refused, so a URL source cannot make Anthropic fetch it', async () => {
  const sent = stubAnthropic();
  const { call } = setup();
  const url = { type: 'url', url: 'https://example.com/huge.pdf' };
  for (const content of [
    [{ type: 'image', source: url }],
    [{ type: 'document', source: url }],
    [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: url }] }],
    [{ type: 'search_result', source: 'x', title: 'x', content: [] }],
  ]) {
    const response = await call('/api/complete/v1/messages', post({ ...minimal, messages: [{ role: 'user', content }] }));
    assert.equal(response.status, 400, JSON.stringify(content));
  }
  const tools = [{ type: 'tool_use', id: 't', name: 'x', input: {} }];
  const result = [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] }];
  const fine = { ...minimal, system: [{ type: 'text', text: 'role' }], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: tools }, { role: 'user', content: result }] };
  assert.equal((await call('/api/complete/v1/messages', post(fine))).status, 200);
  assert.equal(sent.length, 1);
});

test('hour-long cache writes are priced at twice the input price', async () => {
  stubAnthropic({
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 3_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 2_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  } as never);
  const { call, spent } = setup();
  await call('/api/complete/v1/messages', post(minimal));
  assert.equal(spent(), 2_000_000 * 1.25 + 1_000_000 * 2);
});

test('the rate limit counts an IPv6 visitor by their /64, and runs before the budget is read', async () => {
  assert.equal(rateKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:0db8:0001:0002:ffff:1:2:3'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:db8::5'), '2001:db8:0:0::/64');
  assert.equal(rateKey('203.0.113.9'), '203.0.113.9');
  stubAnthropic();
  const { call, limiterKeys, budgetCalls } = setup({ limited: true });
  for (const path of ['/api/status', '/api/fetch?url=https%3A%2F%2Fexample.com%2F']) {
    assert.equal((await call(path, { ip: '2001:db8:1:2:aaaa::1' })).status, 429, path);
  }
  assert.equal((await call('/api/complete/v1/messages', { ...post(minimal), ip: '2001:db8:1:2:bbbb::9' })).status, 429);
  assert.deepEqual(limiterKeys, ['status:2001:db8:1:2::/64', 'fetch:2001:db8:1:2::/64', 'complete:2001:db8:1:2::/64']);
  assert.deepEqual(budgetCalls, []);
});

test('page fetches accept only public http and https addresses', () => {
  assert.equal(checkPageUrl('https://example.com/about'), undefined);
  for (const bad of [
    'file:///etc/passwd', 'ftp://example.com', 'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.5/',
    'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://example.com:8080/',
    'http://intranet/', 'http://printer.local/', 'not a url', 'http://user:pw@example.com/',
    'http://localhost./', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::127.0.0.1]/',
    'http://[64:ff9b::a00:1]/', 'http://[2002:a00:1::]/', 'http://[fec0::1]/', 'http://[ff02::1]/', 'http://198.18.0.1/',
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
  const page = (await ok.json()) as { title: string; text: string };
  assert.equal(page.title, 'Ex');
  assert.equal(page.text, 'Hello & welcome');
  const redirected = await call(`/api/fetch?url=${encodeURIComponent('https://example.com/go')}`);
  assert.equal(redirected.status, 400);
});

test('page text keeps headings, list items and links, and leaves out navigation', () => {
  const html = '<title> A  B </title><meta name="description" content="About us"><nav><a href="/x">Nav</a></nav>' +
    '<main><h1>One</h1><p>Two <a href="/pricing">Pricing</a></p><ul><li>Three</li></ul><a href="/f.pdf">PDF</a></main><footer>Foot</footer>';
  const page = pageText(html, 'https://example.com/');
  assert.equal(page.title, 'A B');
  assert.equal(page.description, 'About us');
  assert.equal(page.text, '# One\n\nTwo Pricing\n\n- Three\n\nPDF');
  assert.deepEqual(page.links, [{ text: 'Pricing', href: 'https://example.com/pricing' }]);
});

test('an out-of-range character reference does not stop the text extraction', () => {
  const page = pageText('<p>a &#1114112; b &#x110000; c &#xD800; d &#65;</p>', 'https://example.com/');
  assert.equal(page.text, 'a \uFFFD b \uFFFD c \uFFFD d A');
});

test('a crafted page at the size cap is read in one pass', () => {
  for (const unit of ['<script ', '<!--', '<main ', '<a href="x">', '<h1>', '<b aria-hidden="true">', '<a', '<title>', '<meta name="description" ']) {
    const html = unit.repeat(Math.floor(MAX_PAGE_BYTES / unit.length));
    const started = performance.now();
    pageText(html, 'https://example.com/');
    assert.ok(performance.now() - started < 500, `${unit} took ${Math.round(performance.now() - started)} ms`);
  }
});
