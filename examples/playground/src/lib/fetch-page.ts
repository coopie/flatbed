/**
 * The `fetch_page` tool, as templates/press/fetch_page.md describes it: it reads one public page
 * through the Worker's `/api/fetch`, saves its text in `sources/` through the host, since `sources/`
 * is a read folder, and gives the agent the saved document and the links on the page.
 */
import type { Tool, ToolResult } from '@flatbed/core';
import { renderDoc, type DocStore } from '@flatbed/docs';

/** What `/api/fetch` returns for a page. */
type Page = { url: string; title: string; description: string; text: string; links: { text: string; href: string }[] };
type FetchError = { type: string; status?: number; contentType?: string; message: string };

const MIN_TEXT = 200;
const MAX_LINKS = 30;
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: false });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Adds https:// when there is no scheme, lowercases the host and drops the fragment. */
export function normalise(raw: string): string | undefined {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    const url = new URL(withScheme);
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/** `sources/` then a slug of the host without www. and the path, such as `sources/quillfern-example-about-us`. */
export function sourceName(address: string): string {
  const url = new URL(address);
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const path = slug(url.pathname) || 'home';
  return `sources/${`${slug(url.hostname.replace(/^www\./, ''))}-${path}`.slice(0, 80).replace(/-+$/, '')}`;
}

function failure(url: string, error: FetchError): string {
  switch (error.type) {
    case 'invalid_url':
      return 'That is not a web address. Give a full address, such as https://example.com/about.';
    case 'not_public':
      return 'That address is not public, so it cannot be fetched. Try a page on the company\'s public site.';
    case 'read_only':
      return 'The playground has used today\'s budget, so no more pages can be fetched today.';
    case 'timeout':
      return `${url} took too long to answer. Try another page.`;
    case 'not_text': {
      const kind = error.contentType?.includes('pdf') ? 'a PDF' : error.contentType?.startsWith('image/') ? 'an image' : 'not HTML';
      return `${url} is ${kind}, not a web page, so it was not saved. Try the page that links to it.`;
    }
    case 'upstream':
      if (error.status === 404 || error.status === 410) return `There is no page at ${url} (${error.status}). Pick a link from a page you have already fetched.`;
      if (error.status === 401 || error.status === 403) return `The site would not show ${url} to the playground (${error.status}). Try another page.`;
      return `${url} could not be fetched${error.status ? ` (${error.status})` : ''}. Try again later, or try another page.`;
    default:
      return `${url} could not be fetched: ${error.message} Try again later, or try another page.`;
  }
}

export type FetchPageOptions = {
  store: DocStore;
  /** Calls `/api/fetch` for one address and returns the response, such as `(url) => fetch('/api/fetch?url=' + ...)`. */
  get: (url: string) => Promise<Response>;
  /** The day a page was fetched, `YYYY-MM-DD`. */
  today?: () => string;
};

export function fetchPageTool({ store, get, today = () => new Date().toISOString().slice(0, 10) }: FetchPageOptions): Tool {
  return {
    name: 'fetch_page',
    description:
      'Read one public web page and save its text in sources/. Returns the saved text and the links on the page. Aim for about six pages per company: the home page, about, a product page and the blog or news page.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full address, such as https://example.com/about' } },
      required: ['url'],
    },
    async run(input) {
      const asked = normalise(typeof input.url === 'string' ? input.url : '');
      if (asked === undefined) return fail(failure('', { type: 'invalid_url', message: '' }));
      let response: Response;
      try {
        response = await get(asked);
      } catch {
        return fail(failure(asked, { type: 'network', message: 'The playground could not be reached.' }));
      }
      const body = (await response.json().catch(() => ({}))) as Page & { error?: FetchError };
      if (!response.ok) return fail(failure(asked, body.error ?? { type: 'unknown', message: `HTTP ${response.status}.` }));
      if (body.text.length < MIN_TEXT) {
        return fail(`${asked} has almost no text without JavaScript, so it was not saved. Try the about or blog page, which are often plain HTML.`);
      }
      const name = sourceName(body.url);
      const summarySource = [body.title, body.description].filter((s) => s !== '').join(' | ') || body.text.replace(/\s+/g, ' ');
      const summary = summarySource.slice(0, 160);
      const doc = await store.put({
        name,
        summary,
        body: `Source: ${body.url}\nFetched: ${today()}\n\n${body.text}`,
        pinned: false,
        writtenBy: "fetch_page",
      });
      const host = new URL(body.url).host;
      const links = [...body.links].sort((a, b) => Number(new URL(b.href).host === host) - Number(new URL(a.href).host === host)).slice(0, MAX_LINKS);
      const words = body.text.split(/\s+/).filter(Boolean).length;
      const redirect = body.url === asked ? '' : `${asked} redirected to ${body.url}.\n`;
      const linkList = links.length > 0 ? `\n\nLinks on this page:\n${links.map((l) => `- ${l.text}: ${l.href}`).join('\n')}` : '';
      return ok(`${redirect}Saved ${name} (${words.toLocaleString('en-GB')} words).\n\n${renderDoc(doc)}${linkList}`);
    },
  };
}
