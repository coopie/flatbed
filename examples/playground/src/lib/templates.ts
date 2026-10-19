/**
 * The playground's template, bundled from templates/press by Vite, and its recorded example,
 * fetched only when a visitor opens it. The recording script writes the example to
 * recordings/press.json. The loader reads any template in the same format; the playground shows one.
 */
import { parseTemplate, type Template } from './template.ts';
import type { Snapshot } from './stores.ts';

const files = import.meta.glob('../../templates/press/**/*.{json,md,css}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const recordings = import.meta.glob('../../recordings/press.json', { import: 'default' }) as Record<string, () => Promise<Snapshot>>;

export const template: Template = parseTemplate(
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path.replace('../../templates/press/', ''), text])),
);

export const hasRecording = Object.keys(recordings).length > 0;
export const loadRecording = () => Object.values(recordings)[0]!();
