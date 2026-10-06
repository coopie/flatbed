import { error, redirect } from '@sveltejs/kit';
import { getHost } from '$lib/server/app.ts';
import { demoPeople } from '$lib/server/fixtures.ts';
import { signIn } from '$lib/server/login.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const host = await getHost();
  const people = host.mode === 'demo' ? demoPeople().map(({ id, name, about }) => ({ id, name, about })) : [];
  return { people, refused: url.searchParams.get('refused') };
};

export const actions: Actions = {
  // Demo mode only: sign in as one of the invented people.
  default: async ({ request, cookies, url }) => {
    const host = await getHost();
    if (host.mode !== 'demo') error(404);
    const id = String((await request.formData()).get('person'));
    if (!demoPeople().some((p) => p.id === id)) error(400, 'No such person.');
    await signIn(host, cookies, id, url.protocol === 'https:');
    redirect(303, '/');
  },
};
