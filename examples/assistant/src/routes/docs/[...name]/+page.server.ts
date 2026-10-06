import { error, fail } from '@sveltejs/kit';
import { getHost } from '$lib/server/app.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const host = await getHost();
  const history = await host.docs(locals.person!.id).history(params.name);
  if (history.length === 0) error(404, `There is no document named ${params.name}.`);
  const latest = history.at(-1)!;
  const asked = Number(url.searchParams.get('v'));
  const shown = history.find((d) => d.version === asked) ?? latest;
  return { doc: shown, latest: latest.version, history: history.map(({ version, writtenAt, writtenBy }) => ({ version, writtenAt, writtenBy })).reverse() };
};

export const actions: Actions = {
  save: async ({ locals, params, request }) => {
    const form = await request.formData();
    const store = (await getHost()).docs(locals.person!.id);
    const doc = await store.get(params.name);
    if (!doc) error(404);
    const body = String(form.get('body') ?? '').replaceAll('\r\n', '\n');
    const summary = String(form.get('summary') ?? '').trim();
    if (!summary) return fail(400, { message: 'Give the document a one-line summary.' });
    await store.put({ ...doc, body, summary, writtenBy: locals.person!.name });
  },
  pin: async ({ locals, params }) => {
    const store = (await getHost()).docs(locals.person!.id);
    const doc = await store.get(params.name);
    if (!doc) error(404);
    await store.put({ ...doc, pinned: !doc.pinned, writtenBy: locals.person!.name });
  },
};
