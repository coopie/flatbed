/** Reads the templates from the disk, for Node: the tests and the recording script. The page uses Vite's glob instead. */
import { readdir, readFile } from 'node:fs/promises';
import { parseTemplate, type Template } from './template.ts';

const root = new URL('../../templates/', import.meta.url);

export async function readTemplateFiles(id: string): Promise<Record<string, string>> {
  const dir = new URL(`${id}/`, root);
  const names = await readdir(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of names.filter((n) => /\.(json|md|css)$/.test(n))) files[name.replaceAll('\\', '/')] = await readFile(new URL(name, dir), 'utf8');
  return files;
}

export async function readTemplates(): Promise<Template[]> {
  const ids = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return Promise.all(ids.map(async (id) => parseTemplate(await readTemplateFiles(id))));
}
