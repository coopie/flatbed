/**
 * Session ids, the memory store, and reading a session file. The memory store keeps sessions in a
 * map, for tests and for hosts that keep them elsewhere. The file store is in file-store.ts, apart,
 * since it needs Node and this file must load in a browser.
 */
import type { Entry, Header, Session, Store } from './types.ts';

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newEntryId(): string {
  return randomHex(4);
}

/**
 * A session id such as `2026-10-06T21-04-11Z-a3f9`, which sorts after `previous`. When the clock
 * has not moved on since the previous session, the id takes the previous id's time and adds one
 * to its hex part, so that a listing still sorts by age.
 */
export function newSessionId(now: Date, previous?: string): string {
  const id = `${now.toISOString().slice(0, 19).replaceAll(':', '-')}Z-${randomHex(2)}`;
  if (previous === undefined || id > previous) return id;
  const cut = previous.lastIndexOf('-');
  const next = Number.parseInt(previous.slice(cut + 1), 16) + 1;
  if (!(next <= 0xffff)) throw new Error(`Cannot make a session id after ${previous}.`);
  return `${previous.slice(0, cut)}-${next.toString(16).padStart(4, '0')}`;
}

export function parseSession(text: string): Session {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const [header, ...entries] = lines.map((line) => JSON.parse(line)) as [Header, ...Entry[]];
  if (header?.type !== 'session') throw new Error('A session file must start with a session header.');
  return { header, entries };
}

export function memoryStore(): Store {
  const sessions = new Map<string, Session>();
  const key = (agent: string, session: string) => `${agent}/${session}`;
  const get = (agent: string, session: string) => {
    const found = sessions.get(key(agent, session));
    if (found === undefined) throw new Error(`No session ${key(agent, session)}.`);
    return found;
  };
  return {
    async list(agent) {
      return [...sessions.values()].filter((s) => s.header.agent === agent).map((s) => s.header.id).sort();
    },
    async read(agent, session) {
      return structuredClone(get(agent, session));
    },
    async create(header) {
      if (sessions.has(key(header.agent, header.id))) throw new Error(`Session ${header.id} already exists.`);
      sessions.set(key(header.agent, header.id), { header: structuredClone(header), entries: [] });
    },
    async append(agent, session, entry) {
      get(agent, session).entries.push(structuredClone(entry));
    },
  };
}
