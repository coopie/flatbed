/**
 * Where an agent's documents live. A store holds one agent's documents and every version of each:
 * a write never changes a version, it adds the next one. The interface is four calls so that a
 * host can put it on another database, such as Postgres, with one table keyed by name and version.
 *
 * A store expects one writer at a time. The plugin queues its own writes, so this only matters to
 * a host that writes to an agent's documents while the agent runs.
 */
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Doc = {
  /** Path-like, such as `soul`, `people/tomas-reyes` or `timeline/2026-10-06`. */
  name: string;
  /** Markdown. */
  body: string;
  /** One line saying what the document is for, shown in listings and in the context. */
  summary: string;
  /** A pinned document is a section of the agent's context in every session. */
  pinned: boolean;
  /** 1 for the first write, then one more for each write after it. */
  version: number;
  writtenAt: string;
  /** Who wrote this version: the agent's id, a person, or `seed`. */
  writtenBy: string;
};

/** What a writer gives; the store adds the version and the time. */
export type DocWrite = Omit<Doc, 'version' | 'writtenAt'>;

export type DocStore = {
  /** The newest version, or undefined when there is no document by that name. */
  get(name: string): Promise<Doc | undefined>;
  /** The newest version of every document, sorted by name. */
  list(): Promise<Doc[]>;
  /** Writes the next version and returns it. */
  put(write: DocWrite): Promise<Doc>;
  /** Every version of one document, oldest first. Empty when there is none. */
  history(name: string): Promise<Doc[]>;
};

const NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/**
 * Why a name will not do, or undefined when it will. Names are lower case so that they mean the
 * same document on a file system that ignores case, and segments cannot start with a dot so that
 * a name cannot climb out of the file store's folder.
 */
export function checkName(name: string): string | undefined {
  if (NAME.test(name) && !name.split('/').some((part) => part.startsWith('.'))) return undefined;
  return `"${name}" is not a document name. Use lower-case words joined by hyphens, with / between folders, such as people/tomas-reyes.`;
}

// Compared by code unit, not `localeCompare`, so the order is the same on every machine.
const byName = (a: Doc, b: Doc) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function next(previous: Doc | undefined, write: DocWrite): Doc {
  const problem = checkName(write.name);
  if (problem !== undefined) throw new Error(problem);
  return { ...write, version: (previous?.version ?? 0) + 1, writtenAt: new Date().toISOString() };
}

export function memoryDocStore(): DocStore {
  const docs = new Map<string, Doc[]>();
  return {
    async get(name) {
      return docs.get(name)?.at(-1);
    },
    async list() {
      return [...docs.values()].map((versions) => versions.at(-1)!).sort(byName);
    },
    async put(write) {
      const versions = docs.get(write.name) ?? [];
      const doc = next(versions.at(-1), write);
      docs.set(write.name, [...versions, doc]);
      return doc;
    },
    async history(name) {
      return [...(docs.get(name) ?? [])];
    },
  };
}

/**
 * One JSONL file per document under `root`, one version per line, such as
 * `<root>/people/tomas-reyes.jsonl`. Give each agent its own root.
 */
export function fileDocStore(root: string): DocStore {
  const fileOf = (name: string) => join(root, `${name}.jsonl`);

  async function history(name: string): Promise<Doc[]> {
    if (checkName(name) !== undefined) return [];
    try {
      const text = await readFile(fileOf(name), 'utf8');
      return text.trim().split('\n').map((line) => JSON.parse(line) as Doc);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  return {
    history,
    async get(name) {
      return (await history(name)).at(-1);
    },
    async list() {
      let files: string[];
      try {
        files = await readdir(root, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const names = files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length).replaceAll('\\', '/'));
      const docs = await Promise.all(names.map(async (name) => (await history(name)).at(-1)));
      return docs.filter((doc): doc is Doc => doc !== undefined).sort(byName);
    },
    async put(write) {
      const doc = next((await history(write.name)).at(-1), write);
      await mkdir(dirname(fileOf(write.name)), { recursive: true });
      await appendFile(fileOf(write.name), `${JSON.stringify(doc)}\n`);
      return doc;
    },
  };
}
