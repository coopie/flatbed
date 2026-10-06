// Server-sent events for the signed-in person: each entry their agent appends, each proposal made
// or decided, and whether the agent is working. The core's onEntry hook feeds the first.
import { error } from '@sveltejs/kit';
import { getHost } from '$lib/server/app.ts';
import type { Update } from '$lib/server/host.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, request }) => {
  if (!locals.person) error(401);
  const host = await getHost();
  const person = locals.person.id;
  let listener: (update: Update) => void;
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(controller) {
      const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
      listener = (update) => send(`data: ${JSON.stringify(update)}\n\n`);
      host.bus.on(person, listener);
      // A comment every 25 seconds keeps proxies from closing a quiet stream.
      ping = setInterval(() => send(': ping\n\n'), 25_000);
      request.signal.addEventListener('abort', () => controller.close());
    },
    cancel() {
      host.bus.off(person, listener);
      clearInterval(ping);
    },
  });
  request.signal.addEventListener('abort', () => {
    host.bus.off(person, listener);
    clearInterval(ping);
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
};
