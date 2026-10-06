import { error } from '@sveltejs/kit';
import { pathOf, renderEvent } from '@flatbed/core';
import { getHost } from '$lib/server/app.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const host = await getHost();
  const ids = await host.sessions.list(locals.person!.id);
  if (!ids.includes(params.id)) error(404, 'No such session.');
  const session = await host.sessions.read(locals.person!.id, params.id);
  const onPath = new Set(pathOf(session.entries).map((e) => e.id));
  return { header: session.header, entries: session.entries.map((entry) => ({ entry, onPath: onPath.has(entry.id), rendered: entry.type === 'event' ? renderEvent(entry) : '' })) };
};
