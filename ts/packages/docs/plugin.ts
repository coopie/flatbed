/**
 * The docs plugin: an agent's documents in place of a system prompt.
 *
 * When a session opens, the context is a short guide, then the pinned documents, then the
 * timeline. The order runs from stable to volatile because providers cache a prefix: the guide
 * never changes, the pinned documents change when the agent edits or pins one, and the timeline
 * changes every day. The cache mark sits on the last pinned document, so a new day costs only
 * the timeline.
 *
 * The only time in the context is the session's day, taken once from the session header, so the
 * same documents always render to the same bytes. A session resumed by a later process gets the
 * same day back, and the tools write to that day's timeline.
 *
 * The tools answer in one line where they can, and a failure is a result that says what to do
 * differently. Nothing here throws to the loop.
 */
import { readFile } from 'node:fs/promises';
import type { Plugin, Section, Session, Tool, ToolResult } from '@flatbed/core';
import { checkName, type Doc, type DocStore } from './store.ts';

export type Seed = { name: string; summary: string; body: string; pinned?: boolean };

export type DocsOptions = {
  /** This agent's documents. Give each agent its own store. */
  store: DocStore;
  /** Documents written when the store has none by that name, such as a soul and guidelines. */
  seeds?: Seed[];
  /** The session's day, `YYYY-MM-DD`. By default, the host's local date when the session opened. */
  today?: (session: Session) => string;
};

/** How many days before today the timeline shows as one line each. */
const EARLIER_DAYS = 6;
const TIMELINE = 'timeline/';

export const GUIDE = `<documents>
You keep a set of Markdown documents, and they are your memory. Each session starts with no memory of the last one: you know what is pinned below and what you can read with read_doc. Before a session ends, write down what the next one will need, because anything not written down is lost.

Pin a document when you need it in every session, such as who you are and how you work. Pinned documents follow this section. Leave the rest unpinned and find them with list_docs. A change to a document, or to what is pinned, reaches your context at the next session.

Give every document a one-line summary that says what it is for, and a name like a path, such as people/tomas-reyes. Keep a document as the current state of its subject: rewrite a line when it stops being true rather than adding another.

Your timeline has one document a day, named timeline/YYYY-MM-DD. You see today's in full and one summary line for each of the six days before it. When something happens that a later session would want to know, add a line with add_to_timeline, and keep the day's summary true.
</documents>`;

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** One document as the model sees it. Trailing whitespace goes, so it cannot change the bytes. */
export function renderDoc(doc: Pick<Doc, 'name' | 'summary' | 'body'>): string {
  return `<doc name="${escape(doc.name)}" summary="${escape(doc.summary)}">\n${doc.body.trimEnd()}\n</doc>`;
}

/** The host's local calendar date of the moment the session opened. */
function localDay(session: Session): string {
  const at = new Date(session.header.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Calendar arithmetic on a day's name, in UTC so the host's timezone cannot shift it. */
function shiftDay(day: string, delta: number): string {
  const at = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + delta);
  return new Date(at).toISOString().slice(0, 10);
}

async function timelineSection(store: DocStore, today: string): Promise<Section> {
  const earlier = await Promise.all(
    Array.from({ length: EARLIER_DAYS }, (_, i) => shiftDay(today, i - EARLIER_DAYS)).map(async (day) => ({
      day,
      doc: await store.get(TIMELINE + day),
    })),
  );
  const lines = earlier.flatMap(({ day, doc }) => (doc ? [`- ${day}: ${doc.summary}`] : []));
  const todayDoc = await store.get(TIMELINE + today);
  const parts = [
    ...(lines.length > 0 ? [lines.join('\n')] : []),
    todayDoc ? renderDoc(todayDoc) : 'Nothing on today\'s timeline yet.',
  ];
  return { name: 'timeline', text: `<timeline today="${today}">\n${parts.join('\n\n')}\n</timeline>` };
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: false });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const notFound = (name: string) => fail(`There is no document named ${name}. Call list_docs to see the names you have.`);

/**
 * How many times `passage` occurs in `text`, without overlaps, stopping at two because the edit
 * only needs to know whether it is exactly one.
 */
function occurrences(text: string, passage: string): number {
  const first = text.indexOf(passage);
  if (first === -1) return 0;
  return text.indexOf(passage, first + passage.length) === -1 ? 1 : 2;
}

export function docsPlugin(options: DocsOptions): Plugin {
  const { store, seeds = [] } = options;
  const dayOf = options.today ?? localDay;
  // Tool calls in one turn run at once, and an edit reads before it writes, so writes take turns.
  let writes: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const done = writes.then(work);
    writes = done.catch(() => undefined);
    return done;
  };

  async function seed() {
    for (const s of seeds) {
      if ((await store.get(s.name)) === undefined) {
        await store.put({ name: s.name, summary: s.summary, body: s.body, pinned: s.pinned ?? true, writtenBy: 'seed' });
      }
    }
  }

  /** Runs a tool's work, turning a store's failure into a result the agent can read. */
  const guarded = async (work: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await work();
    } catch (error) {
      return fail(`The document store failed: ${error instanceof Error ? error.message : String(error)}. Try again, or carry on and mention it on your timeline.`);
    }
  };

  const tools: Tool[] = [
    {
      name: 'list_docs',
      description: 'List your documents, one line each with its summary. Use it to find a document before you read or write it, and before you start a new one, so you add to an existing document rather than making a second.',
      inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'Only names starting with this, such as people/' } } },
      run: (input) => guarded(async () => {
        const prefix = str(input.prefix) ?? '';
        const docs = (await store.list()).filter((d) => d.name.startsWith(prefix));
        if (docs.length === 0) return ok(prefix ? `You have no documents under ${prefix}.` : 'You have no documents yet.');
        return ok(docs.map((d) => `${d.name}${d.pinned ? ' (pinned)' : ''}: ${d.summary}`).join('\n'));
      }),
    },
    {
      name: 'read_doc',
      description: 'Read one of your documents in full. Read a document before you change it, unless it is pinned and already in your context.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      run: (input) => guarded(async () => {
        const name = str(input.name) ?? '';
        const doc = await store.get(name);
        return doc ? ok(renderDoc(doc)) : notFound(name);
      }),
    },
    {
      name: 'write_doc',
      description: 'Write a whole document, creating it or replacing its body. Use it for a new document or a rewrite; use edit_doc to change a passage. The previous version is kept.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Such as people/tomas-reyes' },
          body: { type: 'string', description: 'The whole Markdown body' },
          summary: { type: 'string', description: 'One line saying what the document is for. Required for a new document; leave it out to keep the current one.' },
        },
        required: ['name', 'body'],
      },
      run: (input, ctx) => guarded(() => serially(async () => {
        const name = str(input.name) ?? '';
        const problem = checkName(name);
        if (problem !== undefined) return fail(problem);
        if (name.startsWith(TIMELINE)) return fail('Add to your timeline with add_to_timeline rather than writing it.');
        const existing = await store.get(name);
        const summary = str(input.summary)?.trim() || existing?.summary;
        if (summary === undefined) return fail(`${name} is a new document, so give it a one-line summary saying what it is for.`);
        const doc = await store.put({ name, body: str(input.body) ?? '', summary, pinned: existing?.pinned ?? false, writtenBy: ctx.agent.id });
        return ok(`${existing ? 'Rewrote' : 'Created'} ${name} (version ${doc.version}).`);
      })),
    },
    {
      name: 'edit_doc',
      description: 'Change one passage of a document by replacing it exactly. Copy the passage from the document as it is now, with enough around it to occur only once. Use an empty replacement to delete it.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, passage: { type: 'string' }, replacement: { type: 'string' } },
        required: ['name', 'passage', 'replacement'],
      },
      run: (input, ctx) => guarded(() => serially(async () => {
        const name = str(input.name) ?? '';
        const passage = str(input.passage) ?? '';
        const doc = await store.get(name);
        if (doc === undefined) return notFound(name);
        if (passage === '') return fail('The passage is empty. Copy the text you want to replace from the document.');
        const count = occurrences(doc.body, passage);
        if (count === 0) return fail(`That passage is not in ${name}. Read the document and copy the passage exactly as it is.`);
        if (count > 1) return fail(`That passage occurs more than once in ${name}. Include more of the text around it.`);
        const body = doc.body.replace(passage, () => str(input.replacement) ?? '');
        const written = await store.put({ ...doc, body, writtenBy: ctx.agent.id });
        return ok(`Edited ${name} (version ${written.version}).`);
      })),
    },
    {
      name: 'pin_doc',
      description: 'Pin a document so it is in your context at the start of every session, or unpin it. Pin what you need every time; every pinned document costs room in every session.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, pinned: { type: 'boolean', description: 'true to pin, false to unpin' } },
        required: ['name', 'pinned'],
      },
      run: (input, ctx) => guarded(() => serially(async () => {
        const name = str(input.name) ?? '';
        const pinned = input.pinned === true;
        if (name.startsWith(TIMELINE)) return fail('Your timeline is always in your context, so it needs no pin.');
        const doc = await store.get(name);
        if (doc === undefined) return notFound(name);
        if (doc.pinned === pinned) return ok(`${name} is already ${pinned ? 'pinned' : 'unpinned'}.`);
        await store.put({ ...doc, pinned, writtenBy: ctx.agent.id });
        return ok(`${pinned ? 'Pinned' : 'Unpinned'} ${name}. This takes effect from your next session.`);
      })),
    },
    {
      name: 'add_to_timeline',
      description: "Add a line to today's timeline. Use it whenever something happens that a later session would want to know: what was asked, decided, sent or promised. Later sessions see only the day's summary, so keep it true as the day goes on.",
      inputSchema: {
        type: 'object',
        properties: {
          line: { type: 'string', description: 'One line, such as "Tomas Reyes asked to move Thursday\'s call to Friday."' },
          summary: { type: 'string', description: 'One line for the whole day so far. Give it when the day has changed its shape; leave it out to keep the current one.' },
        },
        required: ['line'],
      },
      run: (input, ctx) => guarded(() => serially(async () => {
        const line = (str(input.line) ?? '').trim().replaceAll('\n', ' ');
        if (line === '') return fail('The line is empty. Say what happened in one line.');
        const name = TIMELINE + dayOf(ctx.session);
        const existing = await store.get(name);
        const body = existing ? `${existing.body.trimEnd()}\n- ${line}` : `- ${line}`;
        const summary = str(input.summary)?.trim() || existing?.summary || line;
        await store.put({ name, body, summary, pinned: false, writtenBy: ctx.agent.id });
        return ok(`Added to ${name}.`);
      })),
    },
  ];

  return {
    name: 'docs',
    async context(ctx) {
      await seed();
      const pinned = (await store.list()).filter((d) => d.pinned && !d.name.startsWith(TIMELINE));
      const stable: Section[] = [{ name: 'documents', text: GUIDE }, ...pinned.map((d) => ({ name: d.name, text: renderDoc(d) }))];
      stable[stable.length - 1] = { ...stable.at(-1)!, cache: true };
      return { sections: [...stable, await timelineSection(store, dayOf(ctx.session))], tools };
    },
  };
}

/** The example soul and note-taking guidelines in `seeds/`, pinned, for a host to start from. */
export async function exampleSeeds(): Promise<Seed[]> {
  const read = (file: string) => readFile(new URL(`./seeds/${file}`, import.meta.url), 'utf8');
  return [
    { name: 'soul', summary: 'Who you are, who you work for and how you judge what matters', body: await read('soul.md') },
    { name: 'guidelines/notes', summary: 'How to keep your documents and timeline', body: await read('notes.md') },
  ];
}
