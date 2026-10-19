// What needs Node: the file store and the example seeds, which are read from files. The main
// entry, index.ts, loads in a browser.
import { readFile } from 'node:fs/promises';
import type { Seed } from './plugin.ts';

export { fileDocStore } from './file-store.ts';

/** The example soul and note-taking guidelines in `seeds/`, pinned, for a host to start from. */
export async function exampleSeeds(): Promise<Seed[]> {
  const read = (file: string) => readFile(new URL(`./seeds/${file}`, import.meta.url), 'utf8');
  return [
    { name: 'soul', summary: 'Who you are, who you work for and how you judge what matters', body: await read('soul.md') },
    { name: 'guidelines/notes', summary: 'How to keep your documents and timeline', body: await read('notes.md') },
  ];
}
