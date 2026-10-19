/**
 * The playground's Worker: it serves the static site and holds Sam's Anthropic key behind two
 * small endpoints, as docs/playground.md describes. It keeps no state about anyone's project.
 *
 * - `POST /api/complete/v1/messages` passes one model call to Anthropic. The page's provider is
 *   core's Anthropic adapter with this path as its base URL, so the body is already in the
 *   Messages API's shape. The guards on spending live here: the model is always Haiku 4.5, the
 *   body is cut down to the fields the agent uses, sizes and `max_tokens` are capped, each IP
 *   address has a rate limit, and a daily spend counter in KV turns the playground read-only once
 *   the day's budget is gone.
 * - `GET /api/fetch?url=` fetches one public web page as text, for the `fetch_page` tool.
 * - `GET /api/status` tells the page whether the day's budget is spent, so it can open read-only.
 *
 * Anything else is a static file from `dist/`, served by the assets binding.
 */

export type Env = {
  ANTHROPIC_API_KEY: string;
  /** Holds one key a day, `spend:YYYY-MM-DD`, with the day's spend in millionths of a dollar. */
  BUDGET: KVNamespace;
  /** Cloudflare's rate-limit binding, keyed by IP address. */
  LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** The day's budget in dollars, as a string, such as "10". */
  DAILY_BUDGET_USD: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Where model calls go. Only tests set it. */
  ANTHROPIC_BASE_URL?: string;
};

export const MODEL = 'claude-haiku-4-5';
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_TOKENS = 4096;
/** The fields the agent and the supervisor send. Anything else is dropped. */
const ALLOWED_FIELDS = ['max_tokens', 'system', 'messages', 'tools', 'cache_control', 'output_config'];
/** Haiku 4.5's prices in millionths of a dollar per token: input, output, cache write, cache read. */
const PRICE = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PAGE_CHARS = 20_000;
const MAX_REDIRECTS = 3;
const PAGE_CACHE_SECONDS = 600;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, error: string, message: string) => json({ type: 'error', error: { type: error, message } }, status);

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/status') return json({ readOnly: await budgetSpent(env) });
    if (url.pathname === '/api/complete/v1/messages') return complete(request, env, ctx);
    if (url.pathname === '/api/fetch') return fetchPage(request, env, ctx);
    if (url.pathname.startsWith('/api/')) return refuse(404, 'not_found', 'No such endpoint.');
    return env.ASSETS.fetch(request);
  },
};

const today = () => new Date().toISOString().slice(0, 10);
const spendKey = () => `spend:${today()}`;

async function spentToday(env: Env): Promise<number> {
  return Number((await env.BUDGET.get(spendKey())) ?? '0') || 0;
}

async function budgetSpent(env: Env): Promise<boolean> {
  return (await spentToday(env)) >= Number(env.DAILY_BUDGET_USD) * 1_000_000;
}

/**
 * Adds a call's cost to the day's counter. KV has no atomic increment, so two calls finishing at
 * once can lose one's cost; the console workspace's spending limit is the backstop for that.
 */
async function addSpend(env: Env, usage: Record<string, unknown>): Promise<void> {
  const n = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
  const cost =
    n('input_tokens') * PRICE.input + n('output_tokens') * PRICE.output +
    n('cache_creation_input_tokens') * PRICE.cacheWrite + n('cache_read_input_tokens') * PRICE.cacheRead;
  try {
    await env.BUDGET.put(spendKey(), String(Math.ceil((await spentToday(env)) + cost)), { expirationTtl: 3 * 86_400 });
  } catch {
    // KV allows about one write a second to a key. A lost write undercounts one call.
  }
}

async function rateLimited(request: Request, env: Env, scope: string): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.LIMITER.limit({ key: `${scope}:${ip}` });
  return !success;
}

/** Reads a body up to `limit` bytes, or returns undefined when it is longer. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | undefined> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * The request Anthropic gets: the allowed fields only, the model forced, `max_tokens` capped, and
 * custom tools only, so a caller cannot reach a server tool such as web search on Sam's key.
 * Returns why when the body will not do.
 */
export function guardRequest(body: unknown): Record<string, unknown> | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'The body must be a JSON object.';
  const input = body as Record<string, unknown>;
  if (!Array.isArray(input.messages)) return 'The body needs messages.';
  const out: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) if (field in input) out[field] = input[field];
  out.model = MODEL;
  const asked = typeof input.max_tokens === 'number' ? input.max_tokens : MAX_TOKENS;
  out.max_tokens = Math.max(1, Math.min(MAX_TOKENS, Math.floor(asked)));
  if (out.tools !== undefined) {
    if (!Array.isArray(out.tools)) return 'tools must be a list.';
    const serverTool = out.tools.some((tool) => typeof tool !== 'object' || tool === null || 'type' in tool || !('input_schema' in tool));
    if (serverTool) return 'Only custom tools with an input_schema are allowed.';
  }
  if (out.output_config !== undefined) {
    const config = out.output_config as Record<string, unknown>;
    out.output_config = config?.format === undefined ? undefined : { format: config.format };
    if (out.output_config === undefined) delete out.output_config;
  }
  return out;
}

async function complete(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  if (request.method !== 'POST') return refuse(405, 'method_not_allowed', 'Use POST.');
  if (await budgetSpent(env)) {
    return refuse(403, 'read_only', "Today's budget for the playground is spent, so it is read-only until tomorrow (UTC).");
  }
  if (await rateLimited(request, env, 'complete')) return refuse(429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_REQUEST_BYTES) return refuse(413, 'too_large', 'The request is too large for the playground.');
  const bytes = await readCapped(request.body, MAX_REQUEST_BYTES);
  if (bytes === undefined) return refuse(413, 'too_large', 'The request is too large for the playground.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refuse(400, 'invalid_request', 'The body is not JSON.');
  }
  const guarded = guardRequest(parsed);
  if (typeof guarded === 'string') return refuse(400, 'invalid_request', guarded);

  const upstream = await fetch(`${env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(guarded),
  });
  const body = await readCapped(upstream.body, MAX_RESPONSE_BYTES);
  if (body === undefined) return refuse(502, 'too_large', 'The model sent back more than the playground passes on.');
  const text = new TextDecoder().decode(body);
  if (upstream.ok) {
    try {
      const usage = (JSON.parse(text) as { usage?: Record<string, unknown> }).usage;
      if (usage) ctx.waitUntil(addSpend(env, usage));
    } catch {
      // A body that is not JSON costs nothing we can count; the page reports the error.
    }
  }
  return new Response(text, { status: upstream.status, headers: { 'content-type': 'application/json' } });
}

/**
 * Why a URL is not one the playground fetches, or undefined when it is: http or https on the
 * default port, with a host name that is not a private, loopback or link-local address. Cloudflare
 * does not route a Worker's requests into a private network, so this is a second line.
 */
export function checkPageUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That is not a web address.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https addresses can be fetched.';
  if (url.port !== '') return 'Only addresses on the usual port can be fetched.';
  if (url.username !== '' || url.password !== '') return 'Addresses with a user name or password cannot be fetched.';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) return 'Only public addresses can be fetched.';
  if (host === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(host)) return 'Only public addresses can be fetched.';
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const priv = a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    if (priv) return 'Only public addresses can be fetched.';
  }
  if (host.includes(':')) {
    // IPv6 literals: refuse loopback, unspecified, unique-local, link-local and mapped IPv4.
    if (host === '::1' || host === '::' || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith('::ffff:')) {
      return 'Only public addresses can be fetched.';
    }
  }
  return undefined;
}

/** A page's title and readable text: scripts, styles and tags removed, entities decoded, space collapsed. */
export function pageText(html: string): { title: string; text: string } {
  const decode = (s: string) =>
    s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg|template|title)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: text.slice(0, MAX_PAGE_CHARS) };
}

async function fetchPage(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  if (request.method !== 'GET') return refuse(405, 'method_not_allowed', 'Use GET.');
  const target = new URL(request.url).searchParams.get('url') ?? '';
  const problem = checkPageUrl(target);
  if (problem !== undefined) return refuse(400, 'invalid_url', problem);
  if (await rateLimited(request, env, 'fetch')) return refuse(429, 'rate_limited', 'Too many requests. Wait a minute and try again.');

  const cache = typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`https://playground-cache.invalid/fetch?url=${encodeURIComponent(target)}`);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  let url = target;
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      response = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'flatbed-playground/0.1 (+https://github.com/coopie/flatbed)', accept: 'text/html,text/plain' } });
    } catch {
      return refuse(502, 'fetch_failed', `Could not reach ${url}.`);
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) break;
    url = new URL(location, url).toString();
    const redirectProblem = checkPageUrl(url);
    if (redirectProblem !== undefined) return refuse(400, 'invalid_url', `The page redirected somewhere the playground does not fetch: ${redirectProblem}`);
    if (hop === MAX_REDIRECTS) return refuse(502, 'fetch_failed', 'The page redirected too many times.');
  }
  if (response === undefined || !response.ok) return refuse(502, 'fetch_failed', `The page answered with HTTP ${response?.status}.`);
  const type = response.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) return refuse(415, 'not_text', 'That address is not a web page.');
  const bytes = await readCapped(response.body, MAX_PAGE_BYTES);
  if (bytes === undefined) return refuse(413, 'too_large', 'The page is too large for the playground.');
  const raw = new TextDecoder().decode(bytes);
  const page = type.includes('text/plain') ? { title: '', text: raw.slice(0, MAX_PAGE_CHARS) } : pageText(raw);
  const result = json({ url, ...page });
  result.headers.set('cache-control', `public, max-age=${PAGE_CACHE_SECONDS}`);
  if (cache) ctx.waitUntil(cache.put(cacheKey, result.clone()));
  return result;
}
