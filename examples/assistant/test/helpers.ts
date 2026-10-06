// A Postgres schema of the test's own, migrated, and dropped when the test is done. The client is
// closed whatever happens, since an open one keeps the test process alive for good. It is ended
// gracefully, never cut, because a cut connection on the pooler can leave a transaction open.
import { connect, migrate, type Sql } from '../src/lib/server/db.ts';
import { env } from '../src/lib/server/env.ts';

export const databaseUrl = env('DATABASE_URL');

export async function testSchema(): Promise<{ sql: Sql; drop(): Promise<void> }> {
  const schema = `assistant_test_${Math.random().toString(16).slice(2, 10)}`;
  const sql = connect(databaseUrl!, schema);
  const drop = async () => {
    try {
      await sql`drop schema if exists ${sql(schema)} cascade`;
    } finally {
      await sql.end();
    }
  };
  try {
    await migrate(sql, schema);
  } catch (error) {
    await drop().catch(() => {});
    throw error;
  }
  return { sql, drop };
}
