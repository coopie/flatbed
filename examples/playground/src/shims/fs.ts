// A stand-in for node:fs in the browser. The supervisor reads its spec schema with readFileSync at
// load, which is the only call it makes, so this answers that one file. See vite.config.ts.
import schema from '../../../../ts/packages/supervisor/spec.schema.json?raw';

export function readFileSync(path: unknown): string {
  if (String(path).endsWith('spec.schema.json')) return schema;
  throw new Error('There is no file system in the browser.');
}
