// Two races the review found: two decisions on one proposal at once, and a wake that arrives as a
// run is finishing. Both run on the scripted demo model. Skipped when DATABASE_URL is not set.
import { equal, ok } from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pathOf } from '@flatbed/core';
import { demoPerson } from '../src/lib/server/fixtures.ts';
import { createHost, type Host, type Update } from '../src/lib/server/host.ts';
import { databaseUrl, testSchema } from './helpers.ts';

const skip = databaseUrl === undefined ? 'DATABASE_URL is not set' : false;
let db: Awaited<ReturnType<typeof testSchema>>;
let host: Host;
before(async () => {
  if (skip) return;
  db = await testSchema();
  host = createHost({ sql: db.sql, mode: 'demo', model: 'faux/demo' });
  await host.seedDemoPeople();
});
after(async () => {
  if (!skip) await db.drop();
});

test('two accepts of one proposal at once send it once', { skip }, async () => {
  const ada = (await host.person('ada'))!;
  await host.send(ada, demoPerson('ada')!.script.ask);
  const [proposal] = await host.proposals(ada);
  ok(proposal, 'expected a proposal');

  const results = await Promise.allSettled([
    host.decide(ada, proposal.id, { outcome: 'accepted' }),
    host.decide(ada, proposal.id, { outcome: 'accepted' }),
  ]);
  equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  equal(results.filter((r) => r.status === 'rejected').length, 1);
  for (const r of results) if (r.status === 'fulfilled') await r.value.run;

  equal((await host.outbox(ada)).length, 1);
  equal((await host.proposals(ada))[0]!.status, 'accepted');
});

test('a wake that arrives as a run is finishing is run', { skip }, async () => {
  const kofi = (await host.person('kofi'))!;
  // The host publishes `working: false` after the run loop has ended and before it is ready for a
  // new run, so a wake from that listener lands in the gap the review found.
  let second: Promise<void> | undefined;
  const listener = (update: Update) => {
    if (update.type === 'working' && !update.working && second === undefined) second = host.send(kofi, 'And one more thing.');
  };
  host.bus.on('kofi', listener);
  try {
    await host.send(kofi, 'Hello.');
    ok(second, 'expected the listener to have sent the second message');
    await second;
  } finally {
    host.bus.off('kofi', listener);
  }

  const ids = await host.sessions.list('kofi');
  const path = pathOf((await host.sessions.read('kofi', ids.at(-1)!)).entries);
  const asked = path.findIndex((e) => e.type === 'event' && e.text === 'And one more thing.');
  ok(asked >= 0, 'expected the second message in the session');
  ok(path.slice(asked).some((e) => e.type === 'message' && e.message.role === 'assistant'), 'expected an answer to the second message');
});
