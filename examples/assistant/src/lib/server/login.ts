// Signing a browser in and out: a random token in an http-only cookie, kept in the logins table.
import type { Cookies } from '@sveltejs/kit';
import type { Host } from './host.ts';

export async function signIn(host: Host, cookies: Cookies, person: string, secure: boolean) {
  const token = crypto.randomUUID();
  await host.sql`insert into logins (token, person) values (${token}, ${person})`;
  cookies.set('login', token, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: 60 * 60 * 24 * 30 });
}

export async function signOut(host: Host, cookies: Cookies) {
  const token = cookies.get('login');
  if (token) await host.sql`delete from logins where token = ${token}`;
  cookies.delete('login', { path: '/' });
}
