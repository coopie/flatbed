/**
 * Settings, from the environment or else from `.env` at the repo root, two folders up from the app,
 * where every command in the README runs. Values go to code and are never printed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let fromFile: Map<string, string> | undefined;

function readDotEnv(): Map<string, string> {
  const values = new Map<string, string>();
  let text = '';
  try {
    text = readFileSync(resolve(process.cwd(), '../../.env'), 'utf8');
  } catch {
    // No .env, as in the container: the environment is all there is.
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) values.set(match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return values;
}

export function env(name: string): string | undefined {
  fromFile ??= readDotEnv();
  return process.env[name] || fromFile.get(name) || undefined;
}
