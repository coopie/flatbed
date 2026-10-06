import { getHost } from '$lib/server/app.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const host = await getHost();
  const ids = await host.sessions.list(locals.person!.id);
  const sessions = await Promise.all(
    ids.reverse().map(async (id) => {
      const { header, entries } = await host.sessions.read(locals.person!.id, id);
      const last = entries.at(-1);
      const first = entries.find((e) => e.type === 'event' && e.kind !== 'notice');
      return {
        id,
        createdAt: header.createdAt,
        entries: entries.length,
        ended: last?.type === 'reset' ? `Reset by ${last.by}${last.reason ? `: ${last.reason}` : ''}` : 'Open',
        opening: first?.type === 'event' ? first.text.slice(0, 120) : '',
      };
    }),
  );
  return { sessions };
};
