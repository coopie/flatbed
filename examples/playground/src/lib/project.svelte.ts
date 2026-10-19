/**
 * One project in the page: a template's agent on IndexedDB, or a recorded example in memory, with
 * the state the pages draw from. Svelte's `$state` makes the fields reactive; the methods are the
 * visitor's actions: send, reveal, download and reset.
 */
import { anthropicProvider, type Agent, type Session, type Store } from '@flatbed/core';
import type { Doc, DocStore } from '@flatbed/docs';
import { strToU8, zipSync } from 'fflate';
import { AGENT_ID, templateAgent } from './agent.ts';
import { fromSnapshot, idbDocStore, idbStore, resetProject, snapshot, unsealedStore } from './stores.ts';
import { loadRecording } from './templates.ts';
import type { Template } from './template.ts';
import { visitorEvent } from './view.ts';

export class Project {
  template: Template;
  /** True for a recorded example, or when the day's budget is spent. */
  readOnly: boolean;
  example: boolean;
  sessions = $state<Session[]>([]);
  docs = $state<Doc[]>([]);
  unsealed = $state<string[]>([]);
  running = $state(false);
  error = $state('');
  private store: Store;
  private docStore: DocStore;
  private agent: Agent | undefined;

  private constructor(template: Template, store: Store, docStore: DocStore, example: boolean, readOnly: boolean) {
    this.template = template;
    this.store = store;
    this.docStore = docStore;
    this.example = example;
    this.readOnly = readOnly;
  }

  /** The visitor's own project, kept in IndexedDB. Seeds are written when the agent first runs. */
  static async live(template: Template, readOnly: boolean): Promise<Project> {
    const project = new Project(template, idbStore(template.id), idbDocStore(template.id), false, readOnly);
    project.unsealed = await unsealedStore(template.id).get();
    project.agent = templateAgent({
      template,
      store: project.store,
      docs: project.docStore,
      provider: anthropicProvider({ apiKey: 'held-by-the-worker', baseUrl: `${location.origin}/api/complete` }),
      unsealed: () => new Set(project.unsealed),
      fetchPage: (url) => fetch(`/api/fetch?url=${encodeURIComponent(url)}`),
      onEntry: () => void project.refresh(),
    });
    await project.seedForShow();
    await project.refresh();
    return project;
  }

  /** A recorded example, from recordings/<id>.json, in memory and read-only. */
  static async example(template: Template): Promise<Project> {
    const snap = await loadRecording(template.id);
    const { store, docs } = await fromSnapshot(snap);
    const project = new Project(template, store, docs, true, true);
    project.unsealed = snap.unsealed;
    await project.refresh();
    return project;
  }

  /**
   * Shows the seed documents before the first run. The docs plugin writes seeds when a session
   * opens, by the same rule: only names the store does not have.
   */
  private async seedForShow() {
    for (const seed of this.template.seeds) {
      if ((await this.docStore.get(seed.name)) === undefined) {
        await this.docStore.put({ name: seed.name, summary: seed.summary, body: seed.body, pinned: seed.pinned ?? true, writtenBy: 'seed' });
      }
    }
  }

  async refresh() {
    const ids = await this.store.list(AGENT_ID);
    this.sessions = await Promise.all(ids.map((id) => this.store.read(AGENT_ID, id)));
    this.docs = await this.docStore.list();
  }

  history(name: string) {
    return this.docStore.history(name);
  }

  async send(text: string) {
    if (this.agent === undefined || this.readOnly || this.running || text.trim() === '') return;
    this.running = true;
    this.error = '';
    try {
      this.agent.deliver(visitorEvent(text.trim()));
      const outcome = await this.agent.run();
      // A reset ends the session; the next message opens a fresh one from the documents.
      if (outcome === 'error') this.error = 'The model call failed. The notice in the chat says why.';
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.running = false;
      await this.refresh();
    }
  }

  /** Opens a sealed folder. The agent can read it at once and sees the change in its folder list from its next session. */
  async reveal(path: string) {
    if (this.example || this.unsealed.includes(path)) return;
    this.unsealed = [...this.unsealed, path];
    await unsealedStore(this.template.id).set(this.unsealed);
  }

  /** A zip of the documents as Markdown, the sessions as JSON Lines, and the whole project as one JSON file. */
  async download(): Promise<Blob> {
    const snap = await snapshot(this.template.id, AGENT_ID, this.store, this.docStore, this.unsealed);
    const files: Record<string, Uint8Array> = {};
    for (const doc of this.docs) files[`${this.template.id}/${doc.name}.md`] = strToU8(`<!-- ${doc.summary} -->\n\n${doc.body}\n`);
    for (const session of snap.sessions) {
      files[`${this.template.id}/sessions/${session.header.id}.jsonl`] = strToU8([session.header, ...session.entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    files[`${this.template.id}/project.json`] = strToU8(JSON.stringify(snap, null, 1));
    return new Blob([zipSync(files)], { type: 'application/zip' });
  }

  async reset() {
    if (this.example) return;
    await resetProject(this.template.id);
    this.unsealed = [];
    await this.seedForShow();
    await this.refresh();
  }
}
