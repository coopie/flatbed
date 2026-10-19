/**
 * Folders with modes, and what a write would leave behind.
 *
 * A host declares folders, each with a mode, and the plugin holds the agent's tools to them. A
 * document belongs to the folder whose path is the longest that starts its name, so a folder can
 * sit inside another. A document outside every folder behaves as if there were no folders.
 *
 * `writeTarget` and `afterWrite` are for a host that checks writes before they land, such as with
 * the supervisor's guard: the first says which document a call would write, and the second what
 * that document would be after it. Neither knows about the supervisor.
 */
import { escapeAttr, escapeText, type ToolCall } from '@flatbed/core';
import { checkName, type Doc, type DocStore } from './store.ts';

/**
 * - `read`: the agent can list and read, and its tools refuse to write; the host writes here.
 * - `write`: the agent can read and write freely.
 * - `reviewed`: as `write` for the plugin; the host checks each write, such as with the supervisor's guard.
 * - `sealed`: hidden from the agent's listing and reading, and its tools refuse to write, until the host gives the folder another mode.
 */
export type FolderMode = 'read' | 'write' | 'reviewed' | 'sealed';

export type Folder = {
  /** Path-like, such as `evidence` or `cases/open`, with no slash at the end. */
  path: string;
  mode: FolderMode;
  /** One line the agent sees about what the folder is for. */
  about?: string;
};

/** Checks the host's folders, and throws on one that could never match a document name. */
export function checkFolders(folders: Folder[]): void {
  for (const folder of folders) {
    if (checkName(folder.path) !== undefined) throw new Error(`"${folder.path}" is not a folder path. Use a document-like name, such as evidence or cases/open.`);
    if (!['read', 'write', 'reviewed', 'sealed'].includes(folder.mode)) throw new Error(`The folder ${folder.path} has no mode named ${folder.mode}.`);
  }
}

/** The folder a document belongs to: the one with the longest path that starts its name. */
export function folderOf(name: string, folders: Folder[]): Folder | undefined {
  let found: Folder | undefined;
  for (const folder of folders) {
    if ((name === folder.path || name.startsWith(`${folder.path}/`)) && folder.path.length > (found?.path.length ?? -1)) found = folder;
  }
  return found;
}

const MODES: Record<FolderMode, string> = {
  read: 'read: you can list and read these documents, but not change them.',
  write: 'write: you can read and write these freely.',
  reviewed:
    'reviewed: you can read these. A supervisor checks each write before it lands, and a write that fails comes back to you with what failed, so you can redraft and write again.',
  sealed: 'sealed: closed to you. You cannot list, read or write in it until it is opened, which takes effect from a later session.',
};

/** The section after the guide that tells the agent its folders, their modes and what each is for. */
export function foldersSection(folders: Folder[]): string {
  const modes = (Object.keys(MODES) as FolderMode[]).filter((mode) => folders.some((f) => f.mode === mode));
  const lines = folders.map((f) => `<folder path="${escapeAttr(f.path)}/" mode="${f.mode}">${escapeText(f.about ?? '')}</folder>`);
  return [
    '<folders>',
    "Your documents are kept in folders, and each folder's mode says what you can do there. You can read and write a document outside these folders freely.",
    '',
    modes.map((mode) => `- ${MODES[mode]}`).join('\n'),
    '',
    lines.join('\n'),
    '</folders>',
  ].join('\n');
}

/** Undoes `escapeText`, for a passage the agent copied from a document as it saw it. */
const unescapeText = (text: string) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/**
 * How many times `passage` occurs in `text`, without overlaps, stopping at two because the edit
 * only needs to know whether it is exactly one.
 */
function occurrences(text: string, passage: string): number {
  const first = text.indexOf(passage);
  if (first === -1) return 0;
  return text.indexOf(passage, first + passage.length) === -1 ? 1 : 2;
}

/** The body after replacing one exact passage, or why the passage will not do. */
export function applyEdit(name: string, body: string, passage: string, replacement: string): { body: string } | { problem: string } {
  if (passage === '') return { problem: 'The passage is empty. Copy the text you want to replace from the document.' };
  // The agent sees bodies escaped, so a passage it copied may hold &amp; where the body has &.
  if (occurrences(body, passage) === 0 && occurrences(body, unescapeText(passage)) > 0) {
    passage = unescapeText(passage);
    replacement = unescapeText(replacement);
  }
  const count = occurrences(body, passage);
  if (count === 0) return { problem: `That passage is not in ${name}. Read the document and copy the passage exactly as it is.` };
  if (count > 1) return { problem: `That passage occurs more than once in ${name}. Include more of the text around it.` };
  return { body: body.replace(passage, () => replacement) };
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** The name of the document a `write_doc` or `edit_doc` call would write, or undefined for any other call. */
export function writeTarget(call: Pick<ToolCall, 'name' | 'input'>): string | undefined {
  if (call.name !== 'write_doc' && call.name !== 'edit_doc') return undefined;
  return str(call.input.name);
}

/**
 * The document as a `write_doc` or `edit_doc` call would leave it, for a check that judges the
 * whole document rather than the call. Undefined when the call is not one of those, or would fail.
 */
export async function afterWrite(store: DocStore, call: Pick<ToolCall, 'name' | 'input'>): Promise<Pick<Doc, 'name' | 'summary' | 'body'> | undefined> {
  const name = writeTarget(call);
  if (name === undefined) return undefined;
  const existing = await store.get(name);
  if (call.name === 'write_doc') {
    const summary = str(call.input.summary)?.trim() || existing?.summary;
    return summary === undefined ? undefined : { name, summary, body: str(call.input.body) ?? '' };
  }
  if (existing === undefined) return undefined;
  const edited = applyEdit(name, existing.body, str(call.input.passage) ?? '', str(call.input.replacement) ?? '');
  return 'body' in edited ? { name, summary: existing.summary, body: edited.body } : undefined;
}
