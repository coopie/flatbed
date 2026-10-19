/**
 * Reviewed folders: each write into one goes past that folder's supervisor spec first, through
 * `@flatbed/supervisor`'s guard, and lands only if the spec passes.
 *
 * The guard picks a spec by tool name, so this plugin runs one guard per reviewed folder and
 * hands a call to the guard for the folder its document is in. Until the docs plugin has folder
 * modes with a hook for it, two things a one-call supervisor needs are added here:
 *
 * - The whole document as it would be after the write. For `edit_doc` that is the current body
 *   with the passage replaced, given as the call's `resulting_document` field.
 * - The material to check against, which may not be in the session: every document in the
 *   template's `read` and `sealed` folders, such as the facts a notice must match or the sealed
 *   solution a casebook must not give away. It reaches the supervisor as one event at the end of
 *   the session it reads, never the agent's own session.
 */
import type { Entry, Plugin, ToolCall } from '@flatbed/core';
import { renderDoc, type DocStore } from '@flatbed/docs';
import { singlePass, supervisorGuard, type Complete, type GuardMode, type Spec, type Supervise } from '@flatbed/supervisor';
import { folderOf, type Folder } from './template.ts';

export type ReviewOptions = {
  folders: Folder[];
  /** The spec for each reviewed folder, by folder path. */
  specs: Record<string, Spec>;
  store: DocStore;
  complete: Complete;
  /** The model name, without the provider prefix. */
  model: string;
  mode: GuardMode;
};

const WRITES = new Set(['write_doc', 'edit_doc']);

/** The document a write would leave, or undefined when the edit would fail anyway. */
async function resultingDocument(call: ToolCall, store: DocStore): Promise<string | undefined> {
  const input = call.input as Record<string, string | undefined>;
  if (call.name === 'write_doc') return input.body ?? '';
  const doc = await store.get(input.name ?? '');
  if (doc === undefined || !input.passage || !doc.body.includes(input.passage)) return undefined;
  return doc.body.replace(input.passage, () => input.replacement ?? '');
}

export function reviewPlugin(options: ReviewOptions): Plugin {
  const { folders, store } = options;
  const evidenceFolders = folders.filter((f) => f.mode === 'read' || f.mode === 'sealed').map((f) => f.path);

  /** The supervisor, given the evidence documents as one event after the session's last entry. */
  const once = singlePass({ complete: options.complete, model: options.model, maxTokens: 4096 });
  const supervise: Supervise = async (input) => {
    const docs = (await store.list()).filter((d) => evidenceFolders.includes(folderOf(folders, d.name)?.path ?? ''));
    const last = input.entries.at(-1);
    const material: Entry = {
      type: 'event',
      id: 'evidence',
      parentId: last?.id ?? null,
      at: last?.at ?? new Date().toISOString(),
      kind: 'reference_documents',
      attrs: { from: 'host' },
      text: `The host attached these documents so you can check the call against them. The agent may not have read them.\n\n${docs.map(renderDoc).join('\n\n')}`,
    };
    const call = input.call as ToolCall | undefined;
    const resulting = call === undefined ? undefined : await resultingDocument(call, store);
    const reviewed = call && resulting !== undefined && call.name === 'edit_doc' ? { ...call, input: { ...call.input, resulting_document: resulting } } : call;
    return once({ ...input, entries: [...input.entries, material], ...(reviewed ? { call: reviewed } : {}) });
  };

  const guards = new Map(
    Object.entries(options.specs).map(([path, spec]) => [
      path,
      supervisorGuard({ specs: { write_doc: spec, edit_doc: spec }, mode: options.mode, supervise }),
    ]),
  );

  return {
    name: 'review',
    async beforeTool(call, ctx) {
      if (!WRITES.has(call.name) || typeof call.input.name !== 'string') return undefined;
      const folder = folderOf(folders, call.input.name);
      if (folder?.mode !== 'reviewed') return undefined;
      return (await guards.get(folder.path)?.beforeTool?.(call, ctx)) ?? undefined;
    },
  };
}
