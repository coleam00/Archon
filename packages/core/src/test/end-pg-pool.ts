import type { Pool } from 'pg';

/**
 * End a test's `pg` pool and resolve once every client's socket has closed.
 *
 * `pool.end()` resolves before its clients' sockets close. A test that then drops its
 * scratch database `WITH (FORCE)` can terminate a client that is still connected, and the
 * error surfaces on a pool with no listener and fails the file. pg-pool emits `remove`
 * for a client once its socket has closed.
 */
export async function endPgPool(pool: Pool): Promise<void> {
  let open = pool.totalCount;
  const closed = new Promise<void>(resolveClosed => {
    if (open === 0) resolveClosed();
    pool.on('remove', () => {
      if (--open === 0) resolveClosed();
    });
  });
  await pool.end();
  await closed;
}
