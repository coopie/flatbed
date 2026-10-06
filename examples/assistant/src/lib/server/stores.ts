/**
 * The core's session store and the docs plugin's document store, on Postgres. They keep the same
 * objects as the file stores, in the same order: a session is a header row and its entries in
 * insertion order, and a document is one row per version.
 *
 * Objects go in as JSON text into `json` columns. A `jsonb` value, or a parameter the driver sends
 * as one, sorts its keys, and then the same session would render to different bytes.
 */
import type { Entry, Header, Session, Store } from '@flatbed/core';
import { checkName, type Doc, type DocStore } from '@flatbed/docs';
import type { Sql } from './db.ts';

export function pgStore(sql: Sql): Store {
  return {
    async list(agent) {
      const rows = await sql<{ id: string }[]>`select id from sessions where agent = ${agent} order by id`;
      return rows.map((row) => row.id);
    },
    async read(agent, session) {
      const [row] = await sql<{ header: Header }[]>`select header from sessions where agent = ${agent} and id = ${session}`;
      if (row === undefined) throw new Error(`No session ${agent}/${session}.`);
      const entries = await sql<{ entry: Entry }[]>`
        select entry from entries where agent = ${agent} and session = ${session} order by seq`;
      return { header: row.header, entries: entries.map((e) => e.entry) } satisfies Session;
    },
    async create(header) {
      await sql`insert into sessions (agent, id, header) values (${header.agent}, ${header.id}, ${JSON.stringify(header)}::text::json)`;
    },
    async append(agent, session, entry) {
      await sql`insert into entries (agent, session, entry) values (${agent}, ${session}, ${JSON.stringify(entry)}::text::json)`;
    },
  };
}

type DocRow = { name: string; version: number; body: string; summary: string; pinned: boolean; written_at: Date; written_by: string };

const toDoc = (row: DocRow): Doc => ({
  name: row.name,
  body: row.body,
  summary: row.summary,
  pinned: row.pinned,
  version: row.version,
  writtenAt: row.written_at.toISOString(),
  writtenBy: row.written_by,
});

// Compared by code unit, as the file store sorts names, so the order is the same on every machine.
const byName = (a: Doc, b: Doc) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** One agent's documents. */
export function pgDocStore(sql: Sql, agent: string): DocStore {
  async function history(name: string) {
    const rows = await sql<DocRow[]>`select * from docs where agent = ${agent} and name = ${name} order by version`;
    return rows.map(toDoc);
  }
  return {
    history,
    async get(name) {
      return (await history(name)).at(-1);
    },
    async list() {
      const rows = await sql<DocRow[]>`
        select distinct on (name) * from docs where agent = ${agent} order by name, version desc`;
      return rows.map(toDoc).sort(byName);
    },
    async put(write) {
      const problem = checkName(write.name);
      if (problem !== undefined) throw new Error(problem);
      // The primary key on (agent, name, version) refuses a second writer that read the same version.
      const [row] = await sql<DocRow[]>`
        insert into docs (agent, name, version, body, summary, pinned, written_at, written_by)
        select ${agent}, ${write.name}, coalesce(max(version), 0) + 1, ${write.body}, ${write.summary}, ${write.pinned}, now(), ${write.writtenBy}
        from docs where agent = ${agent} and name = ${write.name}
        returning *`;
      return toDoc(row!);
    },
  };
}
