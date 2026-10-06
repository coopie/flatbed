// A whole run without a browser, on the scripted demo model: a message leads to an email proposal
// with the supervisor's verdict beside it, the person accepts it with an edit, the email lands in
// the outbox as edited, and the agent hears what changed. Skipped when DATABASE_URL is not set.
import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pathOf } from '@flatbed/core';
import { demoPerson } from '../src/lib/server/fixtures.ts';
import { createHost, type Host } from '../src/lib/server/host.ts';
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

test('a message leads to a proposal, and an accepted proposal reaches the outbox', { skip }, async () => {
  const ada = (await host.person('ada'))!;
  await host.send(ada, demoPerson('ada')!.script.ask);

  const [proposal] = await host.proposals(ada);
  ok(proposal, 'expected a proposal');
  equal(proposal.status, 'pending');
  equal(proposal.input.to, 'Priya Shah <priya@harbour-gallery.example>');
  equal((await host.outbox(ada)).length, 0);

  // The guard's verdict sits in the session beside the call it judged.
  const session = await host.sessions.read('ada', proposal.session);
  const verdicts = session.entries.flatMap((e) => (e.type === 'custom' && e.plugin === 'supervisor' ? [e.data as { mode: string; verdict: { callId?: string; status: string } }] : []));
  equal(verdicts.length, 1);
  deepEqual([verdicts[0]!.mode, verdicts[0]!.verdict.status, verdicts[0]!.verdict.callId], ['shadow', 'given', proposal.callId]);

  const { run } = await host.decide(ada, proposal.id, { outcome: 'accepted', input: { subject: 'Winter show bowls' } });
  await run;
  const [sent] = await host.outbox(ada);
  equal(sent?.input.subject, 'Winter show bowls');
  equal((await host.proposals(ada))[0]!.status, 'accepted');

  const ids = await host.sessions.list('ada');
  const path = pathOf((await host.sessions.read('ada', ids.at(-1)!)).entries);
  const decision = path.find((e) => e.type === 'event' && e.kind === 'decision');
  ok(decision?.type === 'event');
  match(decision.text, /They changed the subject\.\nYours: Re: Bowls for the winter show\nTheirs: Winter show bowls/);
  const timeline = await host.docs('ada').list();
  ok(timeline.some((d) => d.name.startsWith('timeline/') && d.body.includes('Sent the reply to Priya Shah.')));
});
