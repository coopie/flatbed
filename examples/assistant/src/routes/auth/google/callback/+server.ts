// Google sends the browser back here. Only addresses in ALLOWED_EMAILS get in; each becomes a
// person, with an agent, the first time they sign in.
import { error, redirect } from '@sveltejs/kit';
import { allowedEmails, getHost, googleMode } from '$lib/server/app.ts';
import { finishSignIn } from '$lib/server/google/auth.ts';
import { signIn } from '$lib/server/login.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
  if (!googleMode()) error(404);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== cookies.get('oauth_state')) error(400, 'The sign-in did not come from this browser. Try again.');
  cookies.delete('oauth_state', { path: '/' });
  const { email, name, token } = await finishSignIn(url.origin, code);
  if (!allowedEmails().includes(email)) redirect(303, '/signin?refused=1');

  const host = await getHost();
  // The person's id is their address's local part, made safe as an agent id and a document name.
  const id = email.split('@')[0]!.replace(/[^a-z0-9]+/g, '-');
  await host.sql`
    insert into people (id, email, name, google_token) values (${id}, ${email}, ${name}, ${JSON.stringify(token)}::text::json)
    on conflict (id) do update set google_token = excluded.google_token, name = excluded.name`;
  await signIn(host, cookies, id, url.protocol === 'https:');
  redirect(303, '/');
};
