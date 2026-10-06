/**
 * Signing in with Google, over plain HTTP. One consent both signs the person in and grants the
 * Gmail and Calendar scopes perso uses. The token is kept on the person's row, and refreshed here
 * when it has expired.
 *
 * The client is an OAuth client from Google Cloud, from GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
 * A desktop client works on localhost; a deployed app needs a web client with its callback URL
 * registered, as the README says.
 */
import type { Sql } from '../db.ts';
import { env } from '../env.ts';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
];

export type Token = { access_token: string; refresh_token?: string; expires_at: number; id_token?: string };

const client = () => ({ id: env('GOOGLE_CLIENT_ID')!, secret: env('GOOGLE_CLIENT_SECRET')! });
const redirectFor = (origin: string) => `${origin}/auth/google/callback`;

/** Where to send the browser to sign in and consent. */
export function consentUrl(origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: client().id,
    redirect_uri: redirectFor(origin),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Token> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client().id, client_secret: client().secret, ...body }),
  });
  // Google's error bodies name the problem and carry no secret, so they are safe to pass on.
  if (!response.ok) throw new Error(`Google refused the token request: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
  return { ...json, expires_at: Date.now() + json.expires_in * 1000 };
}

/** Swaps the code Google sent back for a token, and reads the signed-in address from it. */
export async function finishSignIn(origin: string, code: string): Promise<{ email: string; name: string; token: Token }> {
  const token = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectFor(origin) });
  // The ID token came straight from Google over TLS, so its payload can be read without checking the signature.
  const payload = JSON.parse(Buffer.from(token.id_token!.split('.')[1]!, 'base64url').toString('utf8')) as { email: string; email_verified?: boolean; name?: string };
  // An account can carry an address its owner has not proved is theirs; only a verified one counts.
  if (payload.email_verified !== true) throw new Error('Google has not verified this address.');
  return { email: payload.email.toLowerCase(), name: payload.name ?? payload.email, token };
}

/** A current access token for the person, refreshed and saved when it has expired. */
export async function accessToken(sql: Sql, person: string): Promise<string> {
  const [row] = await sql<{ google_token: Token | null }[]>`select google_token from people where id = ${person}`;
  const token = row?.google_token;
  if (!token) throw new Error('This person has not connected Google. Sign out and sign in again.');
  if (token.expires_at > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw new Error('Google gave no refresh token. Sign out and sign in again.');
  // While the consent screen is in Testing, Google ends refresh tokens after seven days.
  const fresh = await tokenRequest({ refresh_token: token.refresh_token, grant_type: 'refresh_token' }).catch((error: Error) => {
    throw new Error(`Google no longer accepts this sign-in, so ask the person to sign out and sign in again. ${error.message}`);
  });
  // A refresh answer leaves out the refresh token, so keep the one already saved.
  const saved = { ...token, ...fresh, refresh_token: fresh.refresh_token ?? token.refresh_token };
  await sql`update people set google_token = ${JSON.stringify(saved)}::text::json where id = ${person}`;
  return saved.access_token;
}
