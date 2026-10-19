// Tests for the file store and session ids, which the conformance suite runs only in memory.
import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgent } from './loop.ts';
import { fauxProvider } from './providers/faux.ts';
import { fileStore } from './file-store.ts';
import { newSessionId } from './store.ts';

test('session ids sort after the previous one, even within the same second', () => {
  const now = new Date('2026-10-06T21:04:11.000Z');
  const first = newSessionId(now);
  ok(/^2026-10-06T21-04-11Z-[0-9a-f]{4}$/.test(first));
  equal(newSessionId(now, '2026-10-06T21-04-11Z-ff00'), '2026-10-06T21-04-11Z-ff01');
  ok(newSessionId(now, first) > first);
});

test('the file store keeps sessions as JSONL that a second process can resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flatbed-'));
  try {
    const providers = { faux: fauxProvider([{ content: [{ type: 'text', text: 'One.' }] }, { content: [{ type: 'text', text: 'Two.' }] }]) };
    const first = createAgent({ id: 'a', model: 'faux/test' }, { store: fileStore(root), providers });
    first.deliver({ kind: 'message', text: 'one' });
    equal(await first.run(), 'idle');

    // A new agent object stands in for a restarted process.
    const second = createAgent({ id: 'a', model: 'faux/test' }, { store: fileStore(root), providers });
    second.deliver({ kind: 'message', text: 'two' });
    equal(await second.run(), 'idle');

    const ids = await fileStore(root).list('a');
    equal(ids.length, 1);
    const lines = (await readFile(join(root, 'a', `${ids[0]}.jsonl`), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    equal(lines[0].type, 'session');
    deepEqual(
      lines.slice(1).map((e) => e.type),
      ['context', 'event', 'event', 'message', 'event', 'message'],
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
