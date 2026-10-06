// Who is signed in: a random token in the `login` cookie, looked up in the logins table. Every page
// but sign-in, the Google callback and the tick wants a person.
import { redirect, type Handle } from '@sveltejs/kit';
import { getHost } from '$lib/server/app.ts';

const OPEN = ['/signin', '/auth/', '/api/tick'];

export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get('login');
  if (token) {
    const host = await getHost();
    const [row] = await host.sql<{ person: string }[]>`select person from logins where token = ${token}`;
    if (row) event.locals.person = await host.person(row.person);
  }
  if (!event.locals.person && !OPEN.some((path) => event.url.pathname.startsWith(path))) redirect(303, '/signin');
  return resolve(event);
};
