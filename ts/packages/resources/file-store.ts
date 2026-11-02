// The file store for resources. It needs Node, so it is exported from `@flatbed/resources/node`.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResourceStore, Stored } from './store.ts';

/**
 * One JSONL file per resource under `root`, one version per line, such as `<root>/startup.jsonl`.
 * Give each agent its own root. Writes take turns within the process, so the version check and the
 * append cannot interleave; two processes writing one root at once are not supported.
 */
export function fileResourceStore(root: string): ResourceStore {
  const fileOf = (name: string) => join(root, `${name}.jsonl`);
  let writes: Promise<unknown> = Promise.resolve();

  async function history(name: string): Promise<Stored[]> {
    try {
      const text = await readFile(fileOf(name), 'utf8');
      return text.trim().split('\n').map((line) => JSON.parse(line) as Stored);
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
    put(name, value, expected, by) {
      const done = writes.then(async () => {
        if (((await history(name)).at(-1)?.version ?? 0) !== expected) return undefined;
        const stored: Stored = { value, version: expected + 1, writtenAt: new Date().toISOString(), writtenBy: by };
        await mkdir(root, { recursive: true });
        await appendFile(fileOf(name), `${JSON.stringify(stored)}\n`);
        return stored;
      });
      writes = done.catch(() => undefined);
      return done;
    },
  };
}
