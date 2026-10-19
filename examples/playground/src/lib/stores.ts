/**
 * Where a project lives in the visitor's browser: a session store and a document store on
 * IndexedDB, keyed by project, so each template has one project per browser. Nothing leaves the
 * browser. A snapshot is the same data as plain JSON, for the download, for a recorded example and
 * for loading one back into memory stores.
 */
import { memoryStore, type Session, type Store } from '@flatbed/core';
import { checkName, type Doc, type DocStore, type DocWrite } from '@flatbed/docs';

const DB = 'flatbed-playground';
const SESSIONS = 'sessions';
const DOCS = 'docs';
const META = 'meta';

let opened: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      for (const name of [SESSIONS, DOCS, META]) request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opened;
}

/** Runs `work` in one transaction and resolves with its result once the transaction commits. */
async function tx<T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest | Promise<T> | void): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const t = database.transaction(store, mode);
    let result: T;
    const out = work(t.objectStore(store));
    if (out instanceof IDBRequest) out.onsuccess = () => (result = out.result as T);
    else if (out instanceof Promise) out.then((value) => (result = value), reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const range = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`);

/** Sessions as `{ header, entries }` under `<project>/<agent>/<session>`. */
export function idbStore(project: string): Store {
  const key = (agent: string, session: string) => `${project}/${agent}/${session}`;
  return {
    async list(agent) {
      const keys = await tx<IDBValidKey[]>(SESSIONS, 'readonly', (s) => s.getAllKeys(range(`${project}/${agent}/`)));
      return keys.map((k) => String(k).split('/').at(-1)!).sort();
    },
    async read(agent, session) {
      const found = await tx<Session | undefined>(SESSIONS, 'readonly', (s) => s.get(key(agent, session)));
      if (found === undefined) throw new Error(`No session ${session}.`);
      return found;
    },
    async create(header) {
      await tx(SESSIONS, 'readwrite', (s) => s.add({ header, entries: [] }, key(header.agent, header.id)));
    },
    async append(agent, session, entry) {
      await tx(SESSIONS, 'readwrite', async (s) => {
        const found = await request<Session | undefined>(s.get(key(agent, session)));
        if (found === undefined) throw new Error(`No session ${session}.`);
        found.entries.push(entry);
        await request(s.put(found, key(agent, session)));
      });
    },
  };
}

/** Every version of each document as one array under `<project>/<name>`. */
export function idbDocStore(project: string): DocStore {
  const key = (name: string) => `${project}/${name}`;
  const history = async (name: string) => (await tx<Doc[] | undefined>(DOCS, 'readonly', (s) => s.get(key(name)))) ?? [];
  return {
    history,
    async get(name) {
      return (await history(name)).at(-1);
    },
    async list() {
      const all = await tx<Doc[][]>(DOCS, 'readonly', (s) => s.getAll(range(`${project}/`)));
      return all.map((versions) => versions.at(-1)!).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async put(write: DocWrite) {
      const problem = checkName(write.name);
      if (problem !== undefined) throw new Error(problem);
      return tx<Doc>(DOCS, 'readwrite', async (s) => {
        const versions = (await request<Doc[] | undefined>(s.get(key(write.name)))) ?? [];
        const doc: Doc = { ...write, version: versions.length + 1, writtenAt: new Date().toISOString() };
        await request(s.put([...versions, doc], key(write.name)));
        return doc;
      });
    },
  };
}

/** The sealed folders a project has opened. */
export const unsealedStore = (project: string) => ({
  async get(): Promise<string[]> {
    return (await tx<string[] | undefined>(META, 'readonly', (s) => s.get(`${project}/unsealed`))) ?? [];
  },
  async set(paths: string[]): Promise<void> {
    await tx(META, 'readwrite', (s) => s.put(paths, `${project}/unsealed`));
  },
});

/** Deletes everything a project holds. */
export async function resetProject(project: string): Promise<void> {
  for (const name of [SESSIONS, DOCS, META]) await tx(name, 'readwrite', (s) => s.delete(range(`${project}/`)));
}

/** A whole project as plain data: every session, every version of every document, and what was unsealed. */
export type Snapshot = { template: string; agent: string; recordedAt: string; sessions: Session[]; docs: Doc[][]; unsealed: string[] };

export async function snapshot(template: string, agent: string, store: Store, docs: DocStore, unsealed: string[]): Promise<Snapshot> {
  const sessions = await Promise.all((await store.list(agent)).map((id) => store.read(agent, id)));
  const all = await Promise.all((await docs.list()).map((d) => docs.history(d.name)));
  return { template, agent, recordedAt: new Date().toISOString(), sessions, docs: all, unsealed };
}

/** Memory stores holding a snapshot, for showing a recorded example without touching IndexedDB. */
export async function fromSnapshot(snap: Snapshot): Promise<{ store: Store; docs: DocStore }> {
  const store = memoryStore();
  for (const session of snap.sessions) {
    await store.create(session.header);
    for (const entry of session.entries) await store.append(session.header.agent, session.header.id, entry);
  }
  const byName = new Map(snap.docs.map((versions) => [versions[0]!.name, versions]));
  const docs: DocStore = {
    async get(name) {
      return byName.get(name)?.at(-1);
    },
    async list() {
      return [...byName.values()].map((v) => v.at(-1)!).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async history(name) {
      return [...(byName.get(name) ?? [])];
    },
    async put() {
      throw new Error('A recorded example is read-only.');
    },
  };
  return { store, docs };
}
