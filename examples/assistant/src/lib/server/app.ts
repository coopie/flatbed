/**
 * The one host this server process uses, made on first use: connect, run the migrations, and in
 * demo mode write the demo people. Settings come from the environment, or `.env` at the repo root.
 *
 * - DATABASE_URL: Postgres, required.
 * - FLATBED_MODEL: the agents' model, `anthropic/claude-opus-5-5` unless set; `faux/demo` for the scripted demo.
 * - ANTHROPIC_API_KEY: required for an `anthropic/` model.
 * - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ALLOWED_EMAILS: all three turn on Google mode.
 * - TICK_SECRET: when set, /api/tick wants it as a bearer token.
 */
import { connect, migrate } from './db.ts';
import { env } from './env.ts';
import { createHost, type Host } from './host.ts';

let host: Promise<Host> | undefined;

export const googleMode = () => Boolean(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET') && env('ALLOWED_EMAILS'));

export const allowedEmails = () => (env('ALLOWED_EMAILS') ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export function getHost(): Promise<Host> {
  host ??= (async () => {
    const url = env('DATABASE_URL');
    if (!url) throw new Error('Set DATABASE_URL in .env at the repo root.');
    const sql = connect(url);
    await migrate(sql);
    const mode = googleMode() ? 'google' : 'demo';
    const made = createHost({ sql, mode, model: env('FLATBED_MODEL') ?? 'anthropic/claude-opus-5-5', anthropicKey: env('ANTHROPIC_API_KEY') });
    if (mode === 'demo') await made.seedDemoPeople();
    return made;
  })();
  return host;
}
