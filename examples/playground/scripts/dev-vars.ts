/**
 * Writes .dev.vars, which git ignores, with ANTHROPIC_API_KEY from .env at the repo root, so that
 * `wrangler dev` gives the Worker the key. It reads the value in code and never prints it.
 */
import { writeFile } from 'node:fs/promises';
import { readEnv } from '@flatbed/core/node';

const key = await readEnv('ANTHROPIC_API_KEY');
if (!key) {
  console.error('No ANTHROPIC_API_KEY in .env at the repo root; the playground will answer every model call with an error.');
  process.exit(1);
}
await writeFile(new URL('../.dev.vars', import.meta.url), `ANTHROPIC_API_KEY=${JSON.stringify(key)}\n`, { mode: 0o600 });
console.log('Wrote .dev.vars.');
