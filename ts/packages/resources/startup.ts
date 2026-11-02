/**
 * startup: the resource that decides what each session opens with, in place of pinning.
 *
 * It is a list of tool calls. The `system` entries come first, and each reads one document, which
 * becomes a section of the context. The rest become the core's opening calls, so their results
 * arrive as material in the conversation rather than as instructions in the system prompt.
 *
 * The host keeps the `fixed` entries in code, and its check keeps them as they are. A document a
 * fixed entry reads is read-only to the agent. A stored value that no longer passes the check when
 * a session opens, such as after the host changed its fixed entries, is set aside for that session.
 */
import { escapeAttr, escapeText, type Section, type ToolResult } from '@flatbed/core';
import { folderOf, renderDoc, writeTarget, type DocStore, type Folder } from '@flatbed/docs';
import type { Session } from '@flatbed/core';
import { sameJson } from './patch.ts';
import type { Resource } from './resource.ts';

export const STARTUP = 'startup';

/** One entry of startup: a tool call, and whether it is a system read and whether the host fixed it. */
export type StartupEntry = { name: string; input: Record<string, unknown>; system?: boolean; fixed?: boolean };

export type StartupOptions = {
  /** The fixed entries, kept in code, without the `fixed` flag, which is added. */
  fixed: StartupEntry[];
  /** The documents the system entries read. */
  docs: DocStore;
  /** The docs plugin's folders, if it has any, so that a system read of a sealed document stays empty. */
  folders?: Folder[] | ((session: Session) => Folder[] | Promise<Folder[]>);
};

export const STARTUP_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The tool to call.' },
      input: { type: 'object', description: "The tool's input." },
      system: { type: 'boolean', description: 'A read of one document into the context. System entries come first.' },
      fixed: { type: 'boolean', description: 'Set by the host on its own entries.' },
    },
    required: ['name', 'input'],
    additionalProperties: false,
  },
};

const GUIDE = `What each session opens with: a list of tool calls, each {"name": ..., "input": {...}}, with "system": true or "fixed": true where they apply. The system entries come first, and each reads one document with read_doc into your context. The rest run as each session opens, so their results are the first thing you see. Put a document in a system entry when you need it in every session, and read the rest when you need them. The host set the fixed entries, so they stay as they are, and the documents they read are yours to read but not to change. A change reaches your context at the next session. An edit is refused when it puts a system entry after one that is not, calls a tool you do not have, calls reset, or changes a fixed entry. Add an entry at the end with the path /-, or at a position by its index.`;

/** The document a `system` entry reads, or undefined when the entry is not a read of one document. */
export function systemRead(entry: StartupEntry): string | undefined {
  return entry.name === 'read_doc' && typeof entry.input.name === 'string' ? entry.input.name : undefined;
}

/**
 * Every problem with startup entries that fit the schema, or none. `tools` are the names of the
 * agent's tools; when they are not known, such as when a session opens, names are not checked.
 */
export function startupProblems(entries: StartupEntry[], fixed: StartupEntry[], tools?: string[]): string[] {
  const problems: string[] = [];
  let systemEnded = false;
  for (const [i, entry] of entries.entries()) {
    const at = `The entry at /${i}`;
    if (entry.name === 'reset') problems.push(`${at} calls reset, which would end every session as it opened.`);
    else if (tools !== undefined && !tools.includes(entry.name)) problems.push(`${at} calls ${entry.name}, which is not one of your tools.`);
    if (entry.system !== true) systemEnded = true;
    else if (systemEnded) problems.push(`${at} is a system entry after one that is not. System entries come first.`);
    else if (systemRead(entry) === undefined) problems.push(`${at} is a system entry, so it must read one document with read_doc.`);
  }
  // The fixed entries, in order, must be exactly the host's, flags included.
  const marked = entries.filter((e) => e.fixed === true);
  const normal = (e: StartupEntry) => ({ name: e.name, input: e.input, system: e.system === true, fixed: true });
  for (const [i, want] of fixed.entries()) {
    const got = marked[i];
    if (got === undefined || !sameJson(normal(got), normal(want))) {
      problems.push(`The host's fixed entries must stay as they are and in their order. Fixed entry ${i + 1} should be ${JSON.stringify({ ...want, fixed: true })}.`);
      break;
    }
  }
  if (marked.length > fixed.length) problems.push('Only the host can mark an entry fixed. Take "fixed" off the entries you added.');
  return problems;
}

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export function startupResource(options: StartupOptions): Resource<StartupEntry[]> {
  const fixed = options.fixed.map((e) => ({ ...e, fixed: true }));
  const own = startupProblems(fixed, options.fixed);
  if (own.length > 0) throw new Error(`The fixed startup entries will not do: ${own.join(' ')}`);
  const readOnly = new Set(fixed.flatMap((e) => (e.name === 'read_doc' && typeof e.input.name === 'string' ? [e.input.name] : [])));

  return {
    name: STARTUP,
    guide: GUIDE,
    schema: STARTUP_SCHEMA,
    initial: fixed,
    check(next, _previous, writer) {
      // Checked against the tools of the session the edit is made in.
      const context = writer.tool?.session.entries.findLast((e) => e.type === 'context');
      const tools = context?.type === 'context' ? context.tools.map((t) => t.name) : undefined;
      return startupProblems(next, options.fixed, tools);
    },
    plugin(self) {
      return {
        async context(ctx) {
          const folders = typeof options.folders === 'function' ? await options.folders(ctx.session) : options.folders ?? [];
          const { value } = await self.read();
          const problems = await self.problems(value);
          const chosen = problems.length === 0 ? value : fixed;
          const sections: Section[] = [];
          for (const entry of chosen.filter((e) => e.system === true)) {
            const name = systemRead(entry)!;
            const doc = folderOf(name, folders)?.mode === 'sealed' ? undefined : await options.docs.get(name);
            sections.push({ name, text: doc ? renderDoc(doc) : `<doc name="${escapeAttr(name)}" missing="true"></doc>` });
          }
          if (sections.length > 0) sections[sections.length - 1] = { ...sections.at(-1)!, cache: true };
          if (problems.length > 0) {
            const why = `The startup resource was set aside for this session, which opened with the fixed entries alone, because:\n${problems.map((p) => `- ${p}`).join('\n')}\nFix every one with edit_resource.`;
            sections.push({ name: 'startup-problems', text: `<startup-problems>\n${escapeText(why)}\n</startup-problems>` });
          }
          return { sections, calls: chosen.filter((e) => e.system !== true).map(({ name, input }) => ({ name, input })) };
        },
        beforeTool(call) {
          const target = writeTarget(call);
          if (target === undefined || !readOnly.has(target)) return undefined;
          return fail(`${target} is read by a fixed entry of startup, which the host set, so you can read it but not change it.`);
        },
      };
    },
  };
}
