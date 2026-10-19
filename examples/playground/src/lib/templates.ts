/**
 * The templates, bundled from templates/ by Vite, and each one's recorded example, fetched only
 * when a visitor opens it. The recording script writes the examples to recordings/<id>.json.
 */
import { parseTemplate, type Template } from './template.ts';
import type { Snapshot } from './stores.ts';

const files = import.meta.glob('../../templates/*/**/*.{json,md,css}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const recordings = import.meta.glob('../../recordings/*.json', { import: 'default' }) as Record<string, () => Promise<Snapshot>>;

function group(): Map<string, Record<string, string>> {
  const byTemplate = new Map<string, Record<string, string>>();
  for (const [path, text] of Object.entries(files)) {
    const [id, ...rest] = path.replace('../../templates/', '').split('/');
    const own = byTemplate.get(id!) ?? {};
    own[rest.join('/')] = text;
    byTemplate.set(id!, own);
  }
  return byTemplate;
}

/** The order on the picker. */
const ORDER = ['holmes', 'press'];
export const templates: Template[] = [...group().values()]
  .map(parseTemplate)
  .sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));

export const hasRecording = (id: string) => `../../recordings/${id}.json` in recordings;
export const loadRecording = (id: string) => recordings[`../../recordings/${id}.json`]!();
