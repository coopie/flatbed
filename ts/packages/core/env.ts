// Reads settings from .env at the repo root, for the CLI and the live test. It returns values to
// code and never prints them.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Reads one value from .env at the repo root, falling back to the environment. */
export async function readEnv(name: string): Promise<string | undefined> {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url));
  const text = await readFile(path, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match?.[1] === name) return match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return process.env[name];
}
