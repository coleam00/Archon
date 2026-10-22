import type { Database, SQLQueryBindings } from 'bun:sqlite';

/** bun:sqlite's get() returns null (not undefined) when the query has no row. */
type Maybe<T> = T | null;

/*
 * bun:sqlite does not finalize statements automatically when the connection
 * closes: one unfinalized statement keeps the database file pinned until GC
 * (delete-after-close fails with EBUSY on Windows). So every prepare() against
 * the adapter's connection must funnel through a wrapper that finalizes the
 * statement within the operation's scope: these two, or the adapter's
 * prepareRun (#2875).
 */

export function prepareAll<T>(db: Database, sql: string, params: SQLQueryBindings[] = []): T[] {
  const stmt = db.prepare(sql);
  try {
    return stmt.all(...params) as T[];
  } finally {
    stmt.finalize();
  }
}

export function prepareGet<T>(
  db: Database,
  sql: string,
  params: SQLQueryBindings[] = []
): Maybe<T> {
  const stmt = db.prepare(sql);
  try {
    return stmt.get(...params) as Maybe<T>;
  } finally {
    stmt.finalize();
  }
}
