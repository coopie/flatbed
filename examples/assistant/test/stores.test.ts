// The Postgres stores behave as the core's file store and the docs plugin's file store do: the
// same tests, run against a schema of their own. Skipped when DATABASE_URL is not set.
import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createAgent, fauxProvider } from '@flatbed/core';
import { pgDocStore, pgStore } from '../src/lib/server/stores.ts';
import { databaseUrl, testSchema } from './helpers.ts';

const skip = databaseUrl === undefined ? 'DATABASE_URL is not set' : false;
let db: Awaited<ReturnType<typeof testSchema>>;
before(async () => {
  if (!skip) db = await testSchema();
});
after(async () => {
  if (!skip) await db.drop();
});

test('the session store keeps sessions that a second process can resume', { skip }, async () => {
  const providers = { faux: fauxProvider([{ content: [{ type: 'text', text: 'One.' }] }, { content: [{ type: 'text', text: 'Two.' }] }]) };
  const first = createAgent({ id: 'a', model: 'faux/test' }, { store: pgStore(db.sql), providers });
  first.deliver({ kind: 'message', text: 'one' });
  equal(await first.run(), 'idle');

  // A new agent object stands in for a restarted process.
  const second = createAgent({ id: 'a', model: 'faux/test' }, { store: pgStore(db.sql), providers });
  second.deliver({ kind: 'message', text: 'two' });
  equal(await second.run(), 'idle');

  const store = pgStore(db.sql);
  const ids = await store.list('a');
  equal(ids.length, 1);
  const session = await store.read('a', ids[0]!);
  equal(session.header.type, 'session');
  deepEqual(session.entries.map((e) => e.type), ['context', 'event', 'event', 'message', 'event', 'message']);
  // Keys keep their order, so the same session always renders to the same bytes.
  deepEqual(Object.keys(session.entries[0]!), ['type', 'id', 'parentId', 'at', 'sections', 'tools']);
});

test('the document store keeps every version, and lists the newest of each by name', { skip }, async () => {
  const docs = pgDocStore(db.sql, 'wren');
  await docs.put({ name: 'people/tomas-reyes', summary: 'A customer', body: 'One.', pinned: false, writtenBy: 'wren' });
  await docs.put({ name: 'people/tomas-reyes', summary: 'A customer', body: 'Two.', pinned: true, writtenBy: 'wren' });
  await docs.put({ name: 'soul', summary: 'Who you are', body: 'You are Wren.', pinned: true, writtenBy: 'seed' });
  await pgDocStore(db.sql, 'someone-else').put({ name: 'soul', summary: 'x', body: 'x', pinned: true, writtenBy: 'seed' });
  const again = pgDocStore(db.sql, 'wren');
  deepEqual((await again.list()).map((d) => [d.name, d.version, d.body]), [['people/tomas-reyes', 2, 'Two.'], ['soul', 1, 'You are Wren.']]);
  deepEqual((await again.history('people/tomas-reyes')).map((d) => d.body), ['One.', 'Two.']);
  equal(await again.get('people/nobody'), undefined);
  await docs.put({ name: '../escape', summary: 'x', body: 'x', pinned: false, writtenBy: 'wren' }).then(
    () => ok(false, 'expected a bad name to be refused'),
    (error: Error) => match(error.message, /not a document name/),
  );
});
