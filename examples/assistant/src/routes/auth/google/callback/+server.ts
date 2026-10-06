// Google sends the browser back here. Only verified addresses in ALLOWED_EMAILS get in; each
// becomes a person, with an agent, the first time they sign in.
import { error, redirect } from '@sveltejs/kit';
import { allowedEmails, getHost, googleMode } from '$lib/server/app.ts';
import { finishSignIn } from '$lib/server/google/auth.ts';
import { signIn } from '$lib/server/login.ts';
import type { RequestHandler } from './$types';

const idFor = (email: string) => email.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const GET: RequestHandler = async ({ url, cookies }) => {
  if (!googleMode()) error(404);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== cookies.get('oauth_state')) error(400, 'The sign-in did not come from this browser. Try again.');
  cookies.delete('oauth_state', { path: '/' });
  const { email, name, token } = await finishSignIn(url.origin, code);
  if (!allowedEmails().includes(email)) redirect(303, '/signin?refused=1');

  const host = await getHost();
  // A person is found by their address. A new person's id is the whole address, made safe as an
  // agent id and a document name. Two addresses can make the same id, such as a.b@x and a-b@x; the
  // second is refused rather than given the first one's agent, mail and documents.
  const json = JSON.stringify(token);
  const [created] = await host.sql<{ id: string }[]>`
    insert into people (id, email, name, google_token) values (${idFor(email)}, ${email}, ${name}, ${json}::text::json)
    on conflict do nothing returning id`;
  let id = created?.id;
  if (id === undefined) {
    const [known] = await host.sql<{ id: string }[]>`
      update people set google_token = ${json}::text::json, name = ${name} where email = ${email} returning id`;
    if (known === undefined) error(409, 'Another address already has this account. Ask whoever runs the app to look at it.');
    id = known.id;
  }
  await signIn(host, cookies, id, url.protocol === 'https:');
  redirect(303, '/');
};
