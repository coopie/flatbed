// The file store for documents. It needs Node, so it is exported from `@flatbed/docs/node`.
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { byName, checkName, next, type Doc, type DocStore } from './store.ts';

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
