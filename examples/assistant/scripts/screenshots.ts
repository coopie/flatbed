/**
 * A rough script, kept for the walkthrough: screenshots of every page, light and dark, at desktop
 * and phone width, into screenshots/. It drives a headless Chrome over the DevTools protocol, signed
 * in as one demo person by a login row it writes itself. Run it against a dev server in demo mode
 * that has already played the demo exchange:
 *
 *   node scripts/screenshots.ts [base-url] [person] [tag]
 *
 * With a tag, it shoots only the chat and proposals pages, with the tag in their names, such as
 * `proposals-accepted-desktop-light.png`.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/lib/server/db.ts';
import { env } from '../src/lib/server/env.ts';

const base = process.argv[2] ?? 'http://localhost:5180';
const person = process.argv[3] ?? 'ada';
const tag = process.argv[4];
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const sql = connect(env('DATABASE_URL')!);
const token = crypto.randomUUID();
await sql`insert into logins (token, person) values (${token}, ${person})`;
const [proposal] = await sql<{ id: string }[]>`select id from proposals where agent = ${person} order by created_at desc limit 1`;
const [session] = await sql<{ id: string }[]>`select id from sessions where agent = ${person} order by id desc limit 1`;

const all: [string, string][] = [
  ['signin', '/signin'],
  ['chat', '/'],
  ['proposals', '/proposals'],
  ['documents', '/docs'],
  ['document', `/docs/people/${person}`],
  ['sessions', '/sessions'],
  ...(session ? [['session', `/sessions/${session.id}`] as [string, string]] : []),
  ['timeline', '/timeline'],
];
const pages = tag ? all.filter(([name]) => name === 'chat' || name === 'proposals').map(([name, path]) => [`${name}-${tag}`, path]) : all;

const profile = await mkdtemp(join(tmpdir(), 'assistant-shots-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

try {
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !target; i++) {
    await new Promise((r) => setTimeout(r, 200));
    target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((list) => list.find((t: { type: string }) => t.type === 'page')).catch(() => undefined);
  }
  const ws = new WebSocket(target!.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map<number, (value: any) => void>();
  ws.addEventListener('message', (m) => {
    const data = JSON.parse(String(m.data));
    waiting.get(data.id)?.(data.result);
  });
  const send = (method: string, params: object = {}) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Network.setCookie', { name: 'login', value: token, url: base });
  await mkdir('screenshots', { recursive: true });
  for (const [width, label, mobile] of [[1280, 'desktop', false], [390, 'phone', true]] as const) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile });
    for (const scheme of ['light', 'dark']) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      for (const [name, path] of pages) {
        if (name === 'signin') await send('Network.deleteCookies', { name: 'login', url: base });
        await send('Page.navigate', { url: base + path });
        await new Promise((r) => setTimeout(r, 1500));
        const { cssContentSize } = await send('Page.getLayoutMetrics');
        const clip = { x: 0, y: 0, width, height: Math.max(900, Math.ceil(cssContentSize.height)), scale: 1 };
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
        await writeFile(`screenshots/${name}-${label}-${scheme}.png`, Buffer.from(shot.data, 'base64'));
        if (name === 'signin') await send('Network.setCookie', { name: 'login', value: token, url: base });
      }
    }
  }
  ws.close();
  console.log(`Wrote ${pages.length * 4} screenshots${proposal ? '' : ' (no proposal yet: play the demo first)'}.`);
} finally {
  chrome.kill();
  await sql`delete from logins where token = ${token}`;
  await sql.end();
  await rm(profile, { recursive: true, force: true });
}
