// The main entries of core, docs and supervisor load in a browser: here, with every Node module refused.
// Each test file runs in its own process, so nothing below is loaded before the hook is in place.
import { ok } from 'node:assert/strict';
import { builtinModules, registerHooks } from 'node:module';
import { test } from 'node:test';

test('the main entries import no Node modules, and the node entries do', async () => {
  const builtins = new Set(builtinModules);
  const refused: string[] = [];
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('node:') || builtins.has(specifier)) {
        refused.push(`${specifier} from ${context.parentURL}`);
        throw new Error(`${specifier} is a Node module`);
      }
      return next(specifier, context);
    },
  });
  try {
    for (const entry of ['./index.ts', '../docs/index.ts', '../supervisor/index.ts']) await import(entry);
    ok(refused.length === 0, refused.join('\n'));
    await import('./node.ts').then(() => ok(false, 'expected the node entry to need Node'), () => undefined);
    ok(refused.some((r) => r.includes('core/file-store.ts')), 'the check refuses what it should');
  } finally {
    hooks.deregister();
  }
});
