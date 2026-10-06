import { getHost } from '$lib/server/app.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const host = await getHost();
  await host.seedDocs(locals.person!);
  const docs = (await host.docs(locals.person!.id).list()).filter((d) => !d.name.startsWith('timeline/'));
  return { docs: docs.map(({ name, summary, pinned, version, writtenAt, writtenBy }) => ({ name, summary, pinned, version, writtenAt, writtenBy })) };
};
