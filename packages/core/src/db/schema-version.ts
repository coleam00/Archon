/**
 * Schema vintage (#2316).
 *
 * Archon has no migration ledger: both schemas are re-applied in full, idempotently,
 * on every connection by every process that opens the database. That converges without
 * operator action, but it leaves no record of *which* Archon build created a database
 * or last applied schema to it — so a database whose tables predate a constraint change
 * is structurally different from a fresh one, and nothing can say so.
 *
 * This module defines the single diagnostic row that closes that gap. It is metadata
 * only: nothing in Archon gates, refuses, or warns on these values.
 */
// Imported from the `bundled-build` subpath rather than the `@archon/paths` barrel
// on purpose: 80+ test files mock '@archon/paths' with a partial surface, and both
// adapters record the vintage on construction. Going through the barrel would make
// every one of those mocks responsible for re-exporting a build constant it has no
// interest in. The subpath is a side-effect-free leaf, mirroring '@archon/paths/env-loader'.
import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import type { IDatabase } from './adapters/types';

/**
 * The Archon build recorded as having applied the schema.
 *
 * `'dev'` in source checkouts, the released semver in compiled binaries. The
 * distinction is the point: it is what tells a dev checkout's writes apart from a
 * released binary's against the same `~/.archon/archon.db`.
 */
export const APP_VERSION = BUNDLED_VERSION;

export interface SchemaVersionInfo {
  /**
   * Archon build that created this database, or null when the database predates
   * version tracking. Never back-filled with a guess — an unknown vintage is
   * exactly the fact worth reporting.
   */
  createdAppVersion: string | null;
  /** Archon build that last applied schema to this database. */
  appVersion: string;
  /** When the row was first written (ISO 8601), or null if the column is empty. */
  createdAt: string | null;
  /** When `appVersion` last changed (ISO 8601) — i.e. when the upgrade happened. */
  appliedAt: string | null;
}

/** Row shape as returned by either adapter (SQLite yields TEXT, Postgres yields Date). */
interface SchemaVersionRow {
  created_app_version: string | null;
  app_version: string;
  created_at: string | Date | null;
  applied_at: string | Date | null;
}

function toIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Read the recorded schema vintage, or null when no row was ever written (the write
 * is best-effort on SQLite, so its absence is a legitimate state).
 *
 * SQL errors are not swallowed — they propagate to the caller, which decides how to
 * degrade. Both current callers (`archon doctor`, `GET /api/health`) must stay
 * answerable when the database is unhealthy, so they log and omit rather than fail.
 */
export async function readSchemaVersion(db: IDatabase): Promise<SchemaVersionInfo | null> {
  const result = await db.query<SchemaVersionRow>(
    `SELECT created_app_version, app_version, created_at, applied_at
     FROM remote_agent_schema_version WHERE id = 1`
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    createdAppVersion: row.created_app_version,
    appVersion: row.app_version,
    createdAt: toIso(row.created_at),
    appliedAt: toIso(row.applied_at),
  };
}
