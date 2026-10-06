/**
 * The Postgres connection and the migrations. Every table lives in one schema, `assistant` unless
 * told otherwise, set as the connection's search path so the migrations name no schema and tests
 * can run the same files in a schema of their own.
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

export type Sql = postgres.Sql;

// Found from the working directory, which is the app's folder in development, tests and the image.
const MIGRATIONS = resolve(process.cwd(), 'migrations');

export function connect(url: string, schema = 'assistant'): Sql {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Not a schema name: ${schema}`);
  return postgres(url, { connection: { search_path: schema }, onnotice: () => {}, max: 5 });
}

/** Creates the schema, then runs each migration file not yet run, in name order. */
export async function migrate(sql: Sql, schema = 'assistant'): Promise<void> {
  await sql`create schema if not exists ${sql(schema)}`;
  await sql`create table if not exists migrations (name text primary key, ran_at timestamptz not null default now())`;
  const done = new Set((await sql<{ name: string }[]>`select name from migrations`).map((row) => row.name));
  const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    if (done.has(name)) continue;
    const text = await readFile(resolve(MIGRATIONS, name), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into migrations (name) values (${name})`;
    });
  }
}
