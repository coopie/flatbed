/**
 * Folder modes on top of today's docs plugin, as a thin stand-in until `@flatbed/docs` has them
 * (docs/kickoffs/docs-folders.md). It works only through hooks: a section that tells the agent its
 * folders, `beforeTool` refusals for writes to `read` folders and for anything in a sealed one, and
 * an `afterTool` filter that hides sealed documents from `list_docs`.
 *
 * `reviewed` folders are left to review.ts, which runs a supervisor on each write.
 */
import { escapeAttr, escapeText, type Plugin, type ToolResult } from '@flatbed/core';
import { folderOf, type Folder } from './template.ts';

const WRITES = new Set(['write_doc', 'edit_doc', 'pin_doc']);
const NAMED = new Set(['read_doc', 'write_doc', 'edit_doc', 'pin_doc']);
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const MEANING: Record<Folder['mode'], string> = {
  read: 'you can read these; only the host writes here',
  write: 'yours to read and write freely',
  reviewed: 'you can read these; each write goes past a supervisor and lands only if it passes',
  sealed: 'sealed: you cannot list or read it until it is revealed',
};

export type FoldersOptions = {
  folders: Folder[];
  /** The sealed folders the host has opened, read on every call so an unsealing takes effect at once. */
  unsealed: () => ReadonlySet<string>;
};

export function foldersPlugin({ folders, unsealed }: FoldersOptions): Plugin {
  const modeOf = (name: string) => {
    const folder = folderOf(folders, name);
    if (folder?.mode === 'sealed' && unsealed().has(folder.path)) return 'read';
    return folder?.mode;
  };
  return {
    name: 'folders',
    context() {
      const lines = folders.map((f) => {
        const mode = f.mode === 'sealed' && unsealed().has(f.path) ? 'read' : f.mode;
        const meaning = f.mode === 'sealed' && mode === 'read' ? 'revealed: you can read these now' : MEANING[mode];
        return `<folder path="${escapeAttr(f.path)}/" mode="${mode}">${escapeText(f.about)} (${meaning})</folder>`;
      });
      const text = `<folders>\nYour documents sit in these folders, each with its own rules. Documents outside them are yours to keep as you like.\n${lines.join('\n')}\n</folders>`;
      return { sections: [{ name: 'folders', text }] };
    },
    beforeTool(call) {
      if (!NAMED.has(call.name)) return undefined;
      const name = typeof call.input.name === 'string' ? call.input.name : '';
      const mode = modeOf(name);
      if (mode === 'sealed') {
        return call.name === 'read_doc'
          ? fail(`${folderOf(folders, name)!.path}/ is sealed, so you cannot read it yet. It opens when the visitor asks for it to be revealed.`)
          : fail(`${folderOf(folders, name)!.path}/ is sealed, so nothing can be written there.`);
      }
      if (mode === 'read' && WRITES.has(call.name)) {
        return fail(`${folderOf(folders, name)!.path}/ is a read folder: you can read its documents but not change them. Write your own notes in a folder you can write to.`);
      }
      return undefined;
    },
    afterTool(call, result) {
      if (call.name !== 'list_docs' || result.isError) return undefined;
      const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      const kept = text.split('\n').filter((line) => modeOf(line.split(/[ :]/, 1)[0]!) !== 'sealed');
      return { ...result, content: [{ type: 'text', text: kept.length > 0 ? kept.join('\n') : 'You have no documents you can see there.' }] };
    },
  };
}
