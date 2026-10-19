/**
 * The file store keeps each session as `<root>/<agent>/<session>.jsonl`, one JSON object per line.
 * It needs Node, so it is exported from `@flatbed/core/node`, not the main entry.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSession } from './store.ts';
import type { Store } from './types.ts';

export function fileStore(root: string): Store {
  const dir = (agent: string) => join(root, agent);
  const file = (agent: string, session: string) => join(root, agent, `${session}.jsonl`);
  return {
    async list(agent) {
      try {
        const names = await readdir(dir(agent));
        return names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length)).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
    async read(agent, session) {
      return parseSession(await readFile(file(agent, session), 'utf8'));
    },
    async create(header) {
      await mkdir(dir(header.agent), { recursive: true });
      await writeFile(file(header.agent, header.id), `${JSON.stringify(header)}\n`, { flag: 'wx' });
    },
    async append(agent, session, entry) {
      await appendFile(file(agent, session), `${JSON.stringify(entry)}\n`);
    },
  };
}
