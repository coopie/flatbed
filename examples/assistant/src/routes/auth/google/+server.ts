// Sends the browser to Google to sign in and consent. The state cookie ties the answer to this browser.
import { error, redirect } from '@sveltejs/kit';
import { googleMode } from '$lib/server/app.ts';
import { consentUrl } from '$lib/server/google/auth.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url, cookies }) => {
  if (!googleMode()) error(404);
  const state = crypto.randomUUID();
  cookies.set('oauth_state', state, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 600 });
  redirect(303, consentUrl(url.origin, state));
};
