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
 *
 * A host may give a `startup` list, the fixed entries of startup.json, as startup.ts describes.
 * Then startup.json decides what a session opens with, in place of pinning: its system reads
 * follow the guide where pinned documents would, and its other entries are opening calls.
 *
 * A host may declare folders with modes, as folders.ts describes. The plugin reads them when it
 * builds a session's tools, so a change, such as unsealing a folder, reaches the agent from its
 * next session. With no folders, nothing here changes.
 */
import { escapeAttr, escapeText, type Plugin, type Section, type Session, type Tool, type ToolContext, type ToolResult } from '@flatbed/core';
import { applyEdit, checkFolders, folderOf, foldersSection, type Folder } from './folders.ts';
import { checkStartup, fixedReads, STARTUP_DOC, startupRefusal, systemRead, type StartupEntry } from './startup.ts';
import { checkName, type Doc, type DocStore } from './store.ts';

export type Seed = { name: string; summary: string; body: string; pinned?: boolean };

export type DocsOptions = {
  /** This agent's documents. Give each agent its own store. */
  store: DocStore;
  /** Documents written when the store has none by that name, such as a soul and guidelines. */
  seeds?: Seed[];
  /** The session's day, `YYYY-MM-DD`. By default, the host's local date when the session opened. */
  today?: (session: Session) => string;
  /**
   * Folders with modes, or a function that gives them when a session opens, so that the host can
   * change a mode, such as unsealing a folder, between sessions. None by default.
   */
  folders?: Folder[] | ((session: Session) => Folder[] | Promise<Folder[]>);
  /**
   * The fixed entries of startup.json, kept in code. Given, startup.json decides what a session
   * opens with, and there is no pinning. Leave it out to pin documents instead.
   */
  startup?: StartupEntry[];
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

/** The guide when startup.json decides what a session opens with. */
export const STARTUP_GUIDE = `<documents>
You keep a set of Markdown documents, and they are your memory. Each session starts with no memory of the last one: you know what your startup.json document opens it with, and what you can read with read_doc. Before a session ends, write down what the next one will need, because anything not written down is lost.

startup.json is a list of tool calls, each written as {"name": ..., "input": {...}}, with "system": true or "fixed": true where they apply. The system entries come first, and each reads one document into this context, after this section. The rest run as each session opens, so their results are the first thing you see. Put a document in a system entry when you need it in every session, and read the rest when you need them. The host set the fixed entries, so they stay as they are, and the documents they read are yours to read but not to change. A change to startup.json, or to a document it reads, reaches your context at the next session. A write to startup.json is checked as a whole, and refused with every problem at once when it is not valid JSON, puts a system entry after one that is not, calls a tool you do not have, or changes a fixed entry.

Give every document a one-line summary that says what it is for, and a name like a path, such as people/tomas-reyes. Keep a document as the current state of its subject: rewrite a line when it stops being true rather than adding another.

Your timeline has one document a day, named timeline/YYYY-MM-DD. You see today's in full and one summary line for each of the six days before it. When something happens that a later session would want to know, add a line with add_to_timeline, and keep the day's summary true.
</documents>`;

/**
 * One document as the model sees it, escaped, so a body that holds `</doc>` cannot end it early.
 * Trailing whitespace goes, so it cannot change the bytes.
 */
export function renderDoc(doc: Pick<Doc, 'name' | 'summary' | 'body'>): string {
  return `<doc name="${escapeAttr(doc.name)}" summary="${escapeAttr(doc.summary)}">\n${escapeText(doc.body.trimEnd())}\n</doc>`;
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
  const lines = earlier.flatMap(({ day, doc }) => (doc ? [`- ${day}: ${escapeText(doc.summary)}`] : []));
  const todayDoc = await store.get(TIMELINE + today);
  const parts = [
    ...(lines.length > 0 ? [lines.join('\n')] : []),
    todayDoc ? renderDoc(todayDoc) : 'Nothing on today\'s timeline yet.',
  ];
  return { name: 'timeline', text: `<timeline today="${escapeAttr(today)}">\n${parts.join('\n\n')}\n</timeline>` };
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: false });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const notFound = (name: string) => fail(`There is no document named ${name}. Call list_docs to see the names you have.`);
const sealed = (folder: Folder) => fail(`${folder.path}/ is sealed, so you cannot list, read or write in it until it is opened.`);

/** Why the agent may not change the document `name`, as a result, or undefined when it may. */
function refuseChange(name: string, folders: Folder[]): ToolResult | undefined {
  const folder = folderOf(name, folders);
  if (folder?.mode === 'sealed') return sealed(folder);
  if (folder?.mode !== 'read') return undefined;
  const writable = folders.filter((f) => f.mode === 'write' || f.mode === 'reviewed').map((f) => `${f.path}/`);
  const elsewhere = writable.length > 0 ? ` You can write in ${writable.join(', ')}.` : '';
  return fail(`${name} is in ${folder.path}/, which you can read but not change.${elsewhere}`);
}

export function docsPlugin(options: DocsOptions): Plugin {
  const { store, seeds = [], startup } = options;
  if (startup !== undefined) {
    // The host's own list must pass the check that every write to startup.json passes.
    const checked = checkStartup(JSON.stringify(startup.map((e) => ({ ...e, fixed: true }))), startup);
    if ('problems' in checked) throw new Error(`The startup option will not do: ${checked.problems.join(' ')}`);
  }
  const readOnly = fixedReads(startup ?? []);
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
        await store.put({ name: s.name, summary: s.summary, body: s.body, pinned: startup === undefined && (s.pinned ?? true), writtenBy: 'seed' });
      }
    }
    if (startup !== undefined && (await store.get(STARTUP_DOC)) === undefined) {
      const body = `${JSON.stringify(startup.map((e) => ({ ...e, fixed: true })), null, 2)}\n`;
      await store.put({ name: STARTUP_DOC, summary: 'What each session opens with: system reads first, then opening calls.', body, pinned: false, writtenBy: 'seed' });
    }
  }

  /**
   * Why the agent may not write `body` to `name`, or undefined when it may. A write to startup.json
   * is checked as a whole, against the tools of the session it is made in.
   */
  function refuseBody(name: string, body: string, ctx: ToolContext): ToolResult | undefined {
    if (startup === undefined || name !== STARTUP_DOC) return undefined;
    const context = ctx.session.entries.findLast((e) => e.type === 'context');
    const tools = context?.type === 'context' ? context.tools.map((t) => t.name) : undefined;
    const checked = checkStartup(body, startup, tools);
    return 'problems' in checked ? fail(startupRefusal(checked.problems)) : undefined;
  }

  /** Why the agent may not change `name`, from its folder or from a fixed entry that reads it. */
  function refuse(name: string, folders: Folder[]): ToolResult | undefined {
    if (readOnly.has(name)) return fail(`${name} is read by a fixed entry of ${STARTUP_DOC}, which the host set, so you can read it but not change it.`);
    return refuseChange(name, folders);
  }

  /** Runs a tool's work, turning a store's failure into a result the agent can read. */
  const guarded = async (work: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await work();
    } catch (error) {
      return fail(`The document store failed: ${error instanceof Error ? error.message : String(error)}. Try again, or carry on and mention it on your timeline.`);
    }
  };

  /** Every tool the plugin has, held to one session's folders. */
  const allTools = (folders: Folder[]): Tool[] => [
    {
      name: 'list_docs',
      description: 'List your documents, one line each with its summary. Use it to find a document before you read or write it, and before you start a new one, so you add to an existing document rather than making a second.',
      inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'Only names starting with this, such as people/' } } },
      run: (input) => guarded(async () => {
        const prefix = str(input.prefix) ?? '';
        const within = folderOf(prefix.replace(/\/$/, ''), folders);
        if (within?.mode === 'sealed') return sealed(within);
        const docs = (await store.list()).filter((d) => d.name.startsWith(prefix) && folderOf(d.name, folders)?.mode !== 'sealed');
        if (docs.length === 0) return ok(prefix ? `You have no documents under ${prefix}.` : 'You have no documents yet.');
        return ok(docs.map((d) => `${d.name}${d.pinned && startup === undefined ? ' (pinned)' : ''}: ${d.summary}`).join('\n'));
      }),
    },
    {
      name: 'read_doc',
      description: 'Read one of your documents in full. Read a document before you change it, unless it is pinned and already in your context.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      run: (input) => guarded(async () => {
        const name = str(input.name) ?? '';
        const folder = folderOf(name, folders);
        if (folder?.mode === 'sealed') return sealed(folder);
        const doc = await store.get(name);
        return doc ? ok(renderDoc(doc)) : notFound(name);
      }),
    },
    {
      name: 'write_doc',
      description: 'Write a whole document, creating it or replacing its body, for a new document or a rewrite. To change one passage, use edit_doc instead. The previous version is kept.',
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
        const refused = refuse(name, folders) ?? refuseBody(name, str(input.body) ?? '', ctx);
        if (refused !== undefined) return refused;
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
        const refused = refuse(name, folders);
        if (refused !== undefined) return refused;
        const doc = await store.get(name);
        if (doc === undefined) return notFound(name);
        const edited = applyEdit(name, doc.body, str(input.passage) ?? '', str(input.replacement) ?? '');
        if ('problem' in edited) return fail(edited.problem);
        const refusedBody = refuseBody(name, edited.body, ctx);
        if (refusedBody !== undefined) return refusedBody;
        const written = await store.put({ ...doc, body: edited.body, writtenBy: ctx.agent.id });
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
        const refused = refuse(name, folders);
        if (refused !== undefined) return refused;
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

  /** The tools for one session. With startup.json deciding what a session opens with, nothing is pinned. */
  const toolsFor = (folders: Folder[]) => allTools(folders).filter((tool) => startup === undefined || tool.name !== 'pin_doc');

  /**
   * The documents the system entries of startup.json read, as sections, and its other entries as
   * opening calls. A startup.json that fails the check, such as after the host changed its fixed
   * entries, gives way to the host's entries alone, with a section that says what is wrong.
   */
  async function fromStartup(entries: StartupEntry[], folders: Folder[]) {
    const doc = await store.get(STARTUP_DOC);
    const checked = doc === undefined ? { problems: [`There is no ${STARTUP_DOC}.`] } : checkStartup(doc.body, entries);
    const chosen = 'entries' in checked ? checked.entries : entries;
    const sections: Section[] = [];
    for (const entry of chosen.filter((e) => e.system)) {
      const name = systemRead(entry)!;
      const read = folderOf(name, folders)?.mode === 'sealed' ? undefined : await store.get(name);
      sections.push({ name, text: read ? renderDoc(read) : `<doc name="${escapeAttr(name)}" missing="true"></doc>` });
    }
    const calls = chosen.filter((e) => !e.system).map(({ name, input }) => ({ name, input }));
    const problems = 'problems' in checked
      ? [{ name: 'startup-problems', text: `<startup-problems>\n${escapeText(startupRefusal(checked.problems, `${STARTUP_DOC} was set aside for this session, which opened with the fixed entries alone`))}\n</startup-problems>` }]
      : [];
    return { sections, calls, problems };
  }

  return {
    name: 'docs',
    async context(ctx) {
      const folders = typeof options.folders === 'function' ? await options.folders(ctx.session) : options.folders ?? [];
      checkFolders(folders);
      await seed();
      const opened = startup === undefined ? undefined : await fromStartup(startup, folders);
      const pinned = (await store.list()).filter((d) => d.pinned && !d.name.startsWith(TIMELINE) && folderOf(d.name, folders)?.mode !== 'sealed');
      const stable: Section[] = [
        { name: 'documents', text: startup === undefined ? GUIDE : STARTUP_GUIDE },
        ...(folders.length > 0 ? [{ name: 'folders', text: foldersSection(folders) }] : []),
        ...(opened?.sections ?? pinned.map((d) => ({ name: d.name, text: renderDoc(d) }))),
      ];
      stable[stable.length - 1] = { ...stable.at(-1)!, cache: true };
      const timeline = await timelineSection(store, dayOf(ctx.session));
      return { sections: [...stable, ...(opened?.problems ?? []), timeline], tools: toolsFor(folders), calls: opened?.calls ?? [] };
    },
  };
}
