/**
 * A template's agent, as the page and the recording script both build it: flatbed's core loop with
 * the template's role, the docs plugin with the template's seeds and folders, the supervisor's
 * guard on each reviewed folder, and the app's tools the template names. Every model call, the
 * supervisor's included, goes through one provider, which in the page is the Worker's `/api/complete`.
 */
import { createAgent, type Agent, type Entry, type Event, type Plugin, type Provider, type Store, type Tool } from '@flatbed/core';
import { afterWrite, docsPlugin, renderDoc, writeTarget, type DocStore } from '@flatbed/docs';
import { singlePass, supervisorGuard, type GuardMode } from '@flatbed/supervisor';
import { fetchPageTool } from './fetch-page.ts';
import { folderOf, type Template } from './template.ts';

export const AGENT_ID = 'agent';
export const MODEL = 'claude-haiku-4-5';

export type AgentDeps = {
  template: Template;
  store: Store;
  docs: DocStore;
  provider: Provider;
  /** The sealed folders the visitor has revealed, which the agent then sees as read folders. */
  unsealed: () => ReadonlySet<string>;
  /** Calls `/api/fetch`, for templates that use `fetch_page`. */
  fetchPage: (url: string) => Promise<Response>;
  /** `enforce` refuses failed writes; `shadow` records the verdict and lets them land. */
  reviewMode?: GuardMode;
  /** Called after every entry the agent appends, so the page can redraw. */
  onEntry?: (entry: Entry) => void;
};

/** The role, pinned first, with the opening the visitor already saw, so the agent knows it said it. */
function rolePlugin(template: Template): Plugin {
  const text = `<role>\n${template.role}\n</role>\n\n<opening>You opened the conversation with this message, which the visitor has read:\n${template.opening}</opening>`;
  return { name: 'role', context: () => ({ sections: [{ name: 'role', text }] }) };
}

/** The text of everything in a session that can hold a whole document: context sections, tool results and events. */
function sessionText(entries: readonly Entry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'context') parts.push(...entry.sections.map((s) => s.text));
    else if (entry.type === 'event') parts.push(entry.text);
    else if (entry.type === 'message' && entry.message.role === 'tool') {
      for (const block of entry.message.content) if (block.type === 'text') parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * The guard on reviewed folders. The supervisor makes one call and sees only the agent's session,
 * so it also gets the document as the write would leave it, and every document in the folders the
 * agent can see: the facts a chapter must match, the pages a press release rests on, and the notes
 * and chapters written before a reset, which the session no longer shows.
 *
 * A sealed folder is left out until the visitor reveals it. The supervisor's analysis is shown to
 * the agent and the visitor, so a supervisor that could read the solution could give it away in
 * explaining a refusal, and no instruction makes that safe. Without it the casebook's spoiler check
 * judges what the evidence found so far supports, which the agent, who cannot see the solution
 * either, cannot get past by guessing.
 *
 * A document whose text is already in the session, such as a page `fetch_page` just returned, is
 * not sent twice, which keeps a full press session's supervisor call under the Worker's cap.
 */
function reviewGuard(deps: AgentDeps, folders: () => Template['folders']): Plugin {
  const { template, docs } = deps;
  const single = singlePass({ complete: (request) => deps.provider.complete(request), model: MODEL, maxTokens: 4096 });
  return supervisorGuard({
    mode: deps.reviewMode ?? 'enforce',
    supervise: (input) => {
      const seen = sessionText(input.entries);
      const references = (input.references ?? []).filter((r, i) => i === 0 || !seen.includes(r.text));
      return single({ ...input, references });
    },
    specs: (call) => {
      const target = writeTarget(call);
      const folder = target === undefined ? undefined : folderOf(template.folders, target);
      return folder?.mode === 'reviewed' ? template.specs[folder.path] : undefined;
    },
    references: async (call) => {
      const visible = new Set(folders().filter((f) => f.mode !== 'sealed').map((f) => f.path));
      const after = await afterWrite(docs, call);
      const material = (await docs.list()).filter((d) => d.name !== after?.name && visible.has(folderOf(template.folders, d.name)?.path ?? ''));
      // The first reference is always sent: it is what the check is about.
      return [
        { name: after ? `${after.name}, as this call would leave it` : 'the write', text: after ? renderDoc(after) : 'The write names no document.' },
        ...material.map((d) => ({ name: d.name, text: renderDoc(d) })),
      ];
    },
  });
}

export function templateAgent(deps: AgentDeps): Agent {
  const { template, docs } = deps;
  const tools: Tool[] = [];
  if (template.tools.includes('fetch_page')) tools.push(fetchPageTool({ store: docs, get: deps.fetchPage }));
  const folders = () => template.folders.map((f) => (f.mode === 'sealed' && deps.unsealed().has(f.path) ? { ...f, mode: 'read' as const } : f));
  const plugins: Plugin[] = [
    rolePlugin(template),
    docsPlugin({ store: docs, seeds: template.seeds, folders }),
    reviewGuard(deps, folders),
    { name: 'app-tools', context: () => ({ tools }) },
    { name: 'watch', onEntry: (entry) => deps.onEntry?.(entry) },
  ];
  return createAgent(
    // Limits well under Haiku's window, since every call re-sends the session and the day's budget
    // is small. The agent writes its notes and resets when the soft limit's notice comes. A
    // supervisor call carries the session and its references, so the hard limit is set to keep that
    // under the Worker's 512 KB request cap (worker/api.ts) with six fetched pages in the session.
    { id: AGENT_ID, model: `anthropic/${MODEL}`, plugins, maxTokens: 4096, softLimit: 40_000, hardLimit: 60_000 },
    { store: deps.store, providers: { anthropic: deps.provider } },
  );
}

/**
 * The event that tells the agent a sealed folder was revealed, with its documents in full. The docs
 * plugin builds a session's tools when the session opens, so `read_doc` on the folder works only
 * from the next session; the event lets the agent use the documents in this one.
 */
export async function revealEvent(template: Template, docs: DocStore, path: string): Promise<Event> {
  const inside = (await docs.list()).filter((d) => folderOf(template.folders, d.name)?.path === path);
  return {
    kind: 'reveal',
    attrs: { from: 'host', folder: `${path}/` },
    text: `The visitor revealed ${path}/, so it is no longer sealed: you may read, use and talk about its documents from now on. They follow in full, and from your next session read_doc opens them too.\n\n${inside.map(renderDoc).join('\n\n')}`,
  };
}
