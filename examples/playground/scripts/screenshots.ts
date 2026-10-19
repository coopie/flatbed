/**
 * A rough script: screenshots of the start page, the recorded example and its how-this-works page,
 * light and dark, at desktop and phone width, into screenshots/. It drives a headless Chrome over the DevTools protocol against a
 * running playground (`pnpm dev`):
 *
 *   node scripts/screenshots.ts [base-url]
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;
const pages: [string, string][] = [['start', '/#/'], ['example', '/#/example'], ['how', '/#/example/how']];

const profile = await mkdtemp(join(tmpdir(), 'playground-shots-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
try {
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !target; i++) {
    await new Promise((r) => setTimeout(r, 200));
    target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>).then((list) => list.find((t) => t.type === 'page')).catch(() => undefined);
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

  await mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
  for (const [width, label, mobile] of [[1280, 'desktop', false], [390, 'phone', true]] as const) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile });
    for (const scheme of ['light', 'dark']) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      for (const [name, path] of pages) {
        // Through a blank page, so a change of hash alone still loads the page afresh.
        await send('Page.navigate', { url: 'about:blank' });
        await send('Page.navigate', { url: base + path });
        await new Promise((r) => setTimeout(r, 3000));
        const { cssContentSize } = await send('Page.getLayoutMetrics');
        const clip = { x: 0, y: 0, width, height: Math.min(5000, Math.max(900, Math.ceil(cssContentSize.height))), scale: 1 };
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
        await writeFile(new URL(`../screenshots/${name}-${label}-${scheme}.png`, import.meta.url), Buffer.from(shot.data, 'base64'));
        console.log(`screenshots/${name}-${label}-${scheme}.png`);
      }
    }
  }
  ws.close();
} finally {
  chrome.kill();
  await new Promise((r) => setTimeout(r, 500));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
