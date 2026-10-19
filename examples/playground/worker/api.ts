/**
 * The playground's Worker: it serves the static site and holds Sam's Anthropic key behind two
 * small endpoints, as docs/playground.md describes. It keeps no state about anyone's project.
 *
 * - `POST /api/complete/v1/messages` passes one model call to Anthropic. The page's provider is
 *   core's Anthropic adapter with this path as its base URL, so the body is already in the
 *   Messages API's shape. The guards on spending live here: the model is always Haiku 4.5, the
 *   body is cut down to the fields and content blocks the agent uses, sizes and `max_tokens` are
 *   capped, each IP address has a rate limit, and a daily spend counter in a Durable Object
 *   (budget.ts) turns the playground read-only once the day's budget is gone.
 * - `GET /api/fetch?url=` fetches one public web page as text, for the `fetch_page` tool.
 * - `GET /api/status` tells the page whether the day's budget is spent, so it can open read-only.
 *
 * Anything else is a static file from `dist/`, served by the assets binding.
 */

export type Env = {
  ANTHROPIC_API_KEY: string;
  /** The Durable Object that keeps the day's spend, in budget.ts. The Worker uses one instance, named "budget". */
  BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } };
  /** Cloudflare's rate-limit binding, keyed by IP address. */
  LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** The day's budget in dollars, as a string, such as "10". Anything but a positive number keeps the playground read-only. */
  DAILY_BUDGET_USD: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Where model calls go. Only tests set it. */
  ANTHROPIC_BASE_URL?: string;
};

export const MODEL = 'claude-haiku-4-5';
/**
 * The largest request passed on. The agent resets its session at 40,000 tokens and stops at 60,000
 * (src/lib/agent.ts), and a supervisor call carries that session plus the documents it is given, so
 * a full press session with six pages of 12,000 characters each comes to about 300 KB as JSON.
 * At Haiku's prices the largest request costs about $0.15.
 */
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_TOKENS = 4096;
/** The fields the agent and the supervisor send. Anything else is dropped. */
const ALLOWED_FIELDS = ['max_tokens', 'system', 'messages', 'tools', 'cache_control', 'output_config'];
/**
 * Haiku 4.5's prices in millionths of a dollar per token. A cache write costs 1.25 times the input
 * price when it lasts five minutes and twice when it lasts an hour.
 */
const PRICE = { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 };

/** The largest page fetched. The text extraction is regexes, so a smaller page also bounds its work. */
export const MAX_PAGE_BYTES = 512 * 1024;
/** The most text saved from a page, about 3,000 tokens, so six pages fit in a session and its supervisor call. */
export const MAX_PAGE_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const PAGE_CACHE_SECONDS = 600;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, error: string, message: string) => json({ type: 'error', error: { type: error, message } }, status);
const SPENT = "Today's budget for the playground is spent, so it is read-only until tomorrow (UTC).";

type Ctx = { waitUntil(promise: Promise<unknown>): void };

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const scope = url.pathname === '/api/status' ? 'status' : url.pathname === '/api/fetch' ? 'fetch' : 'complete';
    if (url.pathname.startsWith('/api/') && (await rateLimited(request, env, scope))) {
      return refuse(429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
    }
    if (url.pathname === '/api/status') return json({ readOnly: await budgetSpent(env) });
    if (url.pathname === '/api/complete/v1/messages') return complete(request, env, ctx);
    if (url.pathname === '/api/fetch') return fetchPage(request, env, ctx);
    if (url.pathname.startsWith('/api/')) return refuse(404, 'not_found', 'No such endpoint.');
    return env.ASSETS.fetch(request);
  },
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The day's budget in millionths of a dollar, or 0 when `DAILY_BUDGET_USD` is missing or is not a
 * positive number, which keeps the playground read-only rather than leaving it without a cap.
 */
export function dailyLimit(env: Env): number {
  const raw = (env.DAILY_BUDGET_USD ?? '').trim();
  const dollars = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : 0;
  return dollars > 0 ? Math.floor(dollars * 1_000_000) : 0;
}

const budget = (env: Env) => env.BUDGET.get(env.BUDGET.idFromName('budget'));
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function budgetSpent(env: Env): Promise<boolean> {
  const limit = dailyLimit(env);
  if (limit === 0) return true;
  const { spent } = (await (await budget(env).fetch(`https://budget/spent?day=${today()}`)).json()) as { spent: number };
  return spent >= limit;
}

/** Reserves `amount` against the day's budget, or returns false when that would pass the limit. */
async function reserve(env: Env, amount: number): Promise<boolean> {
  const limit = dailyLimit(env);
  if (limit === 0) return false;
  const response = await budget(env).fetch('https://budget/reserve', post({ day: today(), amount, limit }));
  return ((await response.json()) as { ok: boolean }).ok;
}

/** Adds `amount`, which may be negative, to the day's spend. */
async function settle(env: Env, day: string, amount: number): Promise<void> {
  if (amount !== 0) await budget(env).fetch('https://budget/settle', post({ day, amount }));
}

/** A call's cost from its usage, in millionths of a dollar. */
export function costOf(usage: Record<string, unknown>): number {
  const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  const written = n(usage.cache_creation_input_tokens);
  const split = usage.cache_creation as Record<string, unknown> | undefined;
  const hour = n(split?.ephemeral_1h_input_tokens);
  const writes = split === undefined ? written * PRICE.cacheWrite5m : hour * PRICE.cacheWrite1h + Math.max(0, written - hour) * PRICE.cacheWrite5m;
  return Math.ceil(n(usage.input_tokens) * PRICE.input + n(usage.output_tokens) * PRICE.output + writes + n(usage.cache_read_input_tokens) * PRICE.cacheRead);
}

/**
 * What a call is reserved at before it runs: its body as input tokens, at about four bytes a token
 * and the five-minute cache write price, and a quarter of its `max_tokens` as output. Most calls
 * cost less, and settling corrects it either way.
 */
export const estimate = (bytes: number, maxTokens: number) => Math.ceil((bytes / 4) * PRICE.cacheWrite5m + (maxTokens / 4) * PRICE.output);

/**
 * The key the rate limit counts by: an IPv4 address whole, and an IPv6 address by its first four
 * groups, the /64 a single household or server is given, so that rotating through it does not help.
 */
export function rateKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

async function rateLimited(request: Request, env: Env, scope: string): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.LIMITER.limit({ key: `${scope}:${rateKey(ip)}` });
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
 * Why a content block is not one the agent sends, or undefined when it is. The agent sends text,
 * its tool calls and their results, and nothing else, so an image or document block, which can name
 * a URL for Anthropic to fetch and bill as input, never gets through.
 */
function badBlock(block: unknown, allowed: readonly string[]): string | undefined {
  if (typeof block !== 'object' || block === null) return 'A content block must be an object.';
  const { type, content } = block as { type?: unknown; content?: unknown };
  if (typeof type !== 'string' || !allowed.includes(type)) return `Content blocks of type ${String(type)} are not allowed.`;
  if (type === 'tool_result' && Array.isArray(content)) {
    for (const inner of content) {
      const problem = badBlock(inner, ['text']);
      if (problem !== undefined) return problem;
    }
  } else if (type === 'tool_result' && content !== undefined && typeof content !== 'string') {
    return 'A tool result must hold text.';
  }
  return undefined;
}

/** Why the system prompt or messages hold something the agent does not send, or undefined. */
function badContent(input: Record<string, unknown>): string | undefined {
  if (input.system !== undefined && typeof input.system !== 'string') {
    if (!Array.isArray(input.system)) return 'system must be text or a list of text blocks.';
    for (const block of input.system) {
      const problem = badBlock(block, ['text']);
      if (problem !== undefined) return problem;
    }
  }
  for (const message of input.messages as unknown[]) {
    if (typeof message !== 'object' || message === null) return 'Each message must be an object.';
    const { content } = message as { content?: unknown };
    if (typeof content === 'string') continue;
    if (!Array.isArray(content)) return 'A message must hold text or a list of blocks.';
    for (const block of content) {
      const problem = badBlock(block, ['text', 'tool_use', 'tool_result']);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

/**
 * The request Anthropic gets: the allowed fields only, the model forced, `max_tokens` capped,
 * custom tools only, so a caller cannot reach a server tool such as web search on Sam's key, and
 * only the content blocks the agent sends. Returns why when the body will not do.
 */
export function guardRequest(body: unknown): Record<string, unknown> | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'The body must be a JSON object.';
  const input = body as Record<string, unknown>;
  if (!Array.isArray(input.messages)) return 'The body needs messages.';
  const contentProblem = badContent(input);
  if (contentProblem !== undefined) return contentProblem;
  const out: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) if (field in input) out[field] = input[field];
  out.model = MODEL;
  const asked = typeof input.max_tokens === 'number' && Number.isFinite(input.max_tokens) ? input.max_tokens : MAX_TOKENS;
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

async function complete(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (request.method !== 'POST') return refuse(405, 'method_not_allowed', 'Use POST.');
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

  const day = today();
  const reserved = estimate(bytes.byteLength, guarded.max_tokens as number);
  if (!(await reserve(env, reserved))) return refuse(403, 'read_only', SPENT);
  // Whatever happens next, the reservation is settled against what the call cost: nothing when it
  // failed, and its usage when it worked. A reply that cannot be read keeps the reservation.
  let cost = 0;
  try {
    const upstream = await fetch(`${env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(guarded),
    });
    const body = await readCapped(upstream.body, MAX_RESPONSE_BYTES);
    if (body === undefined) {
      cost = reserved;
      return refuse(502, 'too_large', 'The model sent back more than the playground passes on.');
    }
    const text = new TextDecoder().decode(body);
    if (upstream.ok) {
      try {
        const usage = (JSON.parse(text) as { usage?: Record<string, unknown> }).usage;
        cost = usage ? costOf(usage) : reserved;
      } catch {
        cost = reserved;
      }
    }
    return new Response(text, { status: upstream.status, headers: { 'content-type': 'application/json' } });
  } finally {
    ctx.waitUntil(settle(env, day, cost - reserved));
  }
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
  // A trailing dot names the same host, so `localhost.` is `localhost`.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host.includes('.') && !host.includes(':')) return 'Only public addresses can be fetched.';
  if (host === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(host)) return 'Only public addresses can be fetched.';
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const priv = a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && Number(v4[3]) === 0);
    if (priv) return 'Only public addresses can be fetched.';
  }
  if (host.includes(':')) {
    // IPv6 literals: refuse anything starting `::`, which covers loopback, unspecified and IPv4
    // mapped or embedded the old way, and unique-local, link-local, site-local, multicast, and the
    // NAT64 and 6to4 prefixes, which embed an IPv4 address that may be private.
    if (host.startsWith('::') || /^(fc|fd|fe[89a-f]|ff)/.test(host) || /^(64:ff9b:|2002:)/.test(host)) {
      return 'Only public addresses can be fetched.';
    }
  }
  return undefined;
}

export type Page = { url: string; title: string; description: string; text: string; links: { text: string; href: string }[] };

/** A character reference's character, or U+FFFD when the number is not a character. */
const fromCode = (code: number) => (code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '\uFFFD');
const decode = (s: string) =>
  s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => fromCode(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&');
// `[^<>]` rather than `[^>]`, so a run of `<` with no `>` costs one pass and not one per `<`.
const oneLine = (s: string) => decode(s.replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Elements left out with everything inside them, from the open tag to the first close tag. `<head>`
 * is not among them, since its title and meta description are read on the way past; it holds no
 * text of its own once scripts, styles and the title are gone.
 */
const SKIPPED = new Set(['script', 'style', 'noscript', 'svg', 'template', 'title', 'nav', 'header', 'footer', 'form', 'iframe']);
const LINE_AFTER = new Set(['br', '/p', '/div', '/li', '/tr', '/section', '/article', '/ul', '/ol', '/blockquote']);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];

type Token = { text: string } | { tag: string; name: string };

/**
 * The page as text and tags, with comments and skipped elements left out. Every search moves
 * forward through the page, and a close tag that is not there is remembered, so a crafted page
 * costs one pass and not one per tag, as the lazy regexes it replaced did.
 */
function tokens(html: string, onTitle: (text: string) => void): Token[] {
  const lower = html.toLowerCase();
  const unclosed = new Set<string>();
  const out: Token[] = [];
  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf('<', at);
    if (lt === -1) {
      out.push({ text: html.slice(at) });
      break;
    }
    if (lt > at) out.push({ text: html.slice(at, lt) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break;
      at = end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) break;
    const tag = html.slice(lt + 1, gt);
    const name = (tag.match(/^\/?[a-z][a-z0-9-]*/i)?.[0] ?? '').toLowerCase();
    at = gt + 1;
    if (name === '') continue;
    if (SKIPPED.has(name) || /\baria-hidden\s*=\s*["']true["']/i.test(tag)) {
      // Leave out everything up to the first close tag, or only this tag when there is none.
      const close = unclosed.has(name) ? -1 : lower.indexOf(`</${name}`, at);
      if (close === -1) {
        unclosed.add(name);
        continue;
      }
      if (name === 'title') onTitle(html.slice(at, close));
      const end = html.indexOf('>', close);
      at = end === -1 ? html.length : end + 1;
      continue;
    }
    out.push({ tag, name });
  }
  return out;
}

/**
 * A page as plain Markdown, as the press template's fetch_page.md asks: the title, the meta
 * description, the text of `<main>` or `<article>` when there is one, with headings and list items
 * kept and scripts, navigation, headers, footers and forms left out, and the links on the page.
 * A single pass over the tags rather than a parser, which is enough for the readable text of most pages.
 */
export function pageText(html: string, base: string): Page {
  let title = '';
  let description = '';
  let all = tokens(html, (text) => (title ||= oneLine(text)));
  for (const token of all) {
    if ('name' in token && token.name === 'meta' && attr(token.tag, 'name')?.toLowerCase() === 'description') {
      description ||= oneLine(attr(token.tag, 'content') ?? '');
    }
  }
  for (const element of ['main', 'article']) {
    const start = all.findIndex((t) => 'name' in t && t.name === element);
    const end = start === -1 ? -1 : all.findIndex((t, i) => i > start && 'name' in t && t.name === `/${element}`);
    if (end !== -1) {
      all = all.slice(start, end + 1);
      break;
    }
  }

  const links: Page['links'] = [];
  const seen = new Set<string>();
  const parts: string[] = [];
  let heading = false;
  let link: { href: string; text: string } | undefined;
  for (const token of all) {
    if ('text' in token) {
      const text = decode(token.text);
      parts.push(heading ? text.replace(/\s+/g, ' ') : text);
      if (link) link.text += text;
      continue;
    }
    const { name, tag } = token;
    if (/^h[1-6]$/.test(name)) {
      heading = true;
      parts.push(`\n\n${'#'.repeat(Number(name[1]))} `);
    } else if (/^\/h[1-6]$/.test(name)) {
      heading = false;
      parts.push('\n\n');
    } else if (name === 'li') parts.push('\n- ');
    else if (name === 'p') parts.push('\n\n');
    else if (LINE_AFTER.has(name)) parts.push('\n');
    else parts.push(' ');
    if (name === 'a') {
      const href = attr(tag, 'href');
      link = href ? { href, text: '' } : undefined;
    } else if (name === '/a' && link) {
      addLink(link.href, link.text);
      link = undefined;
    } else if (link) link.text += ' ';
  }

  function addLink(href: string, inner: string) {
    let resolved: URL;
    try {
      resolved = new URL(decode(href), base);
    } catch {
      return;
    }
    resolved.hash = '';
    const text = inner.replace(/\s+/g, ' ').trim();
    if (!/^https?:$/.test(resolved.protocol) || resolved.toString() === base || seen.has(resolved.toString()) || text === '') return;
    if (/\.(pdf|png|jpe?g|gif|webp|svg|zip|mp4|mp3)$/i.test(resolved.pathname)) return;
    seen.add(resolved.toString());
    links.push({ text, href: resolved.toString() });
  }

  const text = parts
    .join('')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { url: base, title, description, text, links };
}

/** Cuts text at the last paragraph break before the limit, and says that it did. */
export function capText(text: string): string {
  if (text.length <= MAX_PAGE_CHARS) return text;
  const cut = text.lastIndexOf('\n\n', MAX_PAGE_CHARS);
  return `${text.slice(0, cut > 0 ? cut : MAX_PAGE_CHARS).trimEnd()}\n\n[The rest of the page was not saved.]`;
}

async function fetchPage(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (request.method !== 'GET') return refuse(405, 'method_not_allowed', 'Use GET.');
  if (await budgetSpent(env)) return refuse(403, 'read_only', SPENT);
  const target = new URL(request.url).searchParams.get('url') ?? '';
  const problem = checkPageUrl(target);
  if (problem !== undefined) return refuse(400, problem.startsWith('Only public') ? 'not_public' : 'invalid_url', problem);

  const cache = typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`https://playground-cache.invalid/fetch?url=${encodeURIComponent(target)}`);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  const upstreamError = (status: number) => json({ type: 'error', error: { type: 'upstream', status, message: `The page answered with HTTP ${status}.` } }, 502);
  let url = target;
  let response: Response | undefined;
  for (let hop = 0; ; hop++) {
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'flatbed-playground/0.1 (+https://github.com/coopie/flatbed)', accept: 'text/html,text/plain' },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') return refuse(504, 'timeout', `${url} took too long to answer.`);
      return upstreamError(0);
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) break;
    if (hop === MAX_REDIRECTS) return refuse(502, 'too_many_redirects', 'The page redirected too many times.');
    url = new URL(location, url).toString();
    const redirectProblem = checkPageUrl(url);
    if (redirectProblem !== undefined) return refuse(400, 'not_public', `The page redirected somewhere the playground does not fetch: ${redirectProblem}`);
  }
  if (!response.ok) return upstreamError(response.status);
  const type = response.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) {
    return json({ type: 'error', error: { type: 'not_text', contentType: type.split(';')[0], message: 'That address is not a web page.' } }, 415);
  }
  const bytes = await readCapped(response.body, MAX_PAGE_BYTES);
  if (bytes === undefined) return refuse(413, 'too_large', 'The page is too large for the playground.');
  const raw = new TextDecoder().decode(bytes);
  const page = type.includes('text/plain') ? { url, title: '', description: '', text: raw, links: [] } : pageText(raw, url);
  const result = json({ ...page, text: capText(page.text) });
  result.headers.set('cache-control', `public, max-age=${PAGE_CACHE_SECONDS}`);
  if (cache) ctx.waitUntil(cache.put(cacheKey, result.clone()));
  return result;
}
