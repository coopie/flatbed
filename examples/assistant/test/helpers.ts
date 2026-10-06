// A Postgres schema of the test's own, migrated, and dropped when the test is done.
import { connect, migrate, type Sql } from '../src/lib/server/db.ts';
import { env } from '../src/lib/server/env.ts';

export const databaseUrl = env('DATABASE_URL');

export async function testSchema(): Promise<{ sql: Sql; drop(): Promise<void> }> {
  const schema = `assistant_test_${Math.random().toString(16).slice(2, 10)}`;
  const sql = connect(databaseUrl!, schema);
  await migrate(sql, schema);
  return {
    sql,
    async drop() {
      await sql`drop schema ${sql(schema)} cascade`;
      await sql.end();
    },
  };
}
