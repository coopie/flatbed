/**
 * A template's agent, as the page and the recording script both build it: flatbed's core loop with
 * the template's role, the docs plugin seeded from the template, folder modes, a supervisor on each
 * reviewed folder, and the app's tools the template names. Every model call, the supervisor's
 * included, goes through one provider, which in the page is the Worker's `/api/complete`.
 */
import { createAgent, type Agent, type Entry, type Plugin, type Provider, type Store } from '@flatbed/core';
import { docsPlugin, type DocStore } from '@flatbed/docs';
import type { GuardMode } from '@flatbed/supervisor';
import { fetchPageTool } from './fetch-page.ts';
import { foldersPlugin } from './folders.ts';
import { reviewPlugin } from './review.ts';
import type { Template } from './template.ts';

export const AGENT_ID = 'agent';
export const MODEL = 'claude-haiku-4-5';

export type AgentDeps = {
  template: Template;
  store: Store;
  docs: DocStore;
  provider: Provider;
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

export function templateAgent(deps: AgentDeps): Agent {
  const { template, docs } = deps;
  const tools = [];
  if (template.tools.includes('fetch_page')) tools.push(fetchPageTool({ store: docs, get: deps.fetchPage }));
  const plugins: Plugin[] = [
    rolePlugin(template),
    docsPlugin({ store: docs, seeds: template.seeds }),
    foldersPlugin({ folders: template.folders, unsealed: deps.unsealed }),
    reviewPlugin({
      folders: template.folders,
      specs: template.specs,
      store: docs,
      complete: (request) => deps.provider.complete(request),
      model: MODEL,
      mode: deps.reviewMode ?? 'enforce',
    }),
    { name: 'app-tools', context: () => ({ tools }) },
    { name: 'watch', onEntry: (entry) => deps.onEntry?.(entry) },
  ];
  return createAgent(
    // Limits well under Haiku's window, since every call re-sends the session and the visitor's
    // budget is small. The agent writes its notes and resets when the soft limit's notice comes.
    { id: AGENT_ID, model: `anthropic/${MODEL}`, plugins, maxTokens: 4096, softLimit: 60_000, hardLimit: 100_000 },
    { store: deps.store, providers: { anthropic: deps.provider } },
  );
}
