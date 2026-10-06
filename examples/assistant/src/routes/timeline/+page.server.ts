import { getHost } from '$lib/server/app.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const docs = await (await getHost()).docs(locals.person!.id).list();
  const days = docs.filter((d) => d.name.startsWith('timeline/')).reverse();
  return { days: days.map(({ name, summary, body }) => ({ name, day: name.slice('timeline/'.length), summary, body })) };
};
