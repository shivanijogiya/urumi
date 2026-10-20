import type pg from 'pg';

/** Runs `fn` in a transaction on one client: COMMIT on success, ROLLBACK on any throw. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // If ROLLBACK itself fails the connection is suspect: release it as broken.
    await client.query('ROLLBACK').catch((e: Error) => (broken = e));
    throw err;
  } finally {
    client.release(broken);
  }
}
