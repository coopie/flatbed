// A scheduler calls this to have every agent check for new mail. With TICK_SECRET set, it wants
// that as a bearer token. It answers at once; the agents run on.
import { error, json } from '@sveltejs/kit';
import { getHost } from '$lib/server/app.ts';
import { env } from '$lib/server/env.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  const secret = env('TICK_SECRET');
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) error(401);
  const host = await getHost();
  const people = await host.people();
  for (const person of people) void host.tick(person);
  return json({ ticked: people.map((p) => p.id) });
};
