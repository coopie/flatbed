import { getHost } from '$lib/server/app.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  const host = await getHost();
  const person = locals.person;
  const waiting = person ? (await host.proposals(person)).filter((p) => p.status === 'pending').length : 0;
  return { person, mode: host.mode, waiting, working: person ? host.isWorking(person.id) : false };
};
