// A scheduler calls this to have the agents check for new mail. It wants TICK_SECRET as a bearer
// token, and in production refuses every call when none is set. It answers at once; the agents run on.
import { createHash, timingSafeEqual } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
import { allowedEmails, getHost, production } from '$lib/server/app.ts';
import { env } from '$lib/server/env.ts';
import type { RequestHandler } from './$types';

// Hashed first, so the two sides have the same length and the comparison takes the same time whatever they hold.
const digest = (text: string) => createHash('sha256').update(text).digest();

export const POST: RequestHandler = async ({ request }) => {
  const secret = env('TICK_SECRET');
  if (secret === undefined) {
    if (production) error(503, 'Set TICK_SECRET to use the tick.');
  } else if (!timingSafeEqual(digest(request.headers.get('authorization') ?? ''), digest(`Bearer ${secret}`))) {
    error(401);
  }
  const host = await getHost();
  const people = await host.tickable(allowedEmails());
  for (const person of people) void host.tick(person);
  return json({ ticked: people.map((p) => p.id) });
};
