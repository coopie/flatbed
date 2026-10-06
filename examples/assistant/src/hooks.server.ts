// Who is signed in: a random token in the `login` cookie, looked up in the logins table. A login
// lasts 30 days, and in Google mode only while the person's address is still in ALLOWED_EMAILS, so
// taking someone off the list signs them out at their next request. Every page but sign-in, the
// Google callback and the tick wants a person.
import { redirect, type Handle } from '@sveltejs/kit';
import { allowedEmails, getHost } from '$lib/server/app.ts';
import { LOGIN_DAYS, signOut } from '$lib/server/login.ts';

const OPEN = ['/signin', '/auth/', '/api/tick'];

export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get('login');
  if (token) {
    const host = await getHost();
    const [row] = await host.sql<{ person: string }[]>`
      select person from logins where token = ${token} and created_at > now() - make_interval(days => ${LOGIN_DAYS})`;
    const person = row && (await host.person(row.person));
    if (person && (host.mode === 'demo' || allowedEmails().includes(person.email))) event.locals.person = person;
    else await signOut(host, event.cookies);
  }
  if (!event.locals.person && !OPEN.some((path) => event.url.pathname.startsWith(path))) redirect(303, '/signin');
  return resolve(event);
};
