import type { Database } from 'bun:sqlite';
import { createLogger } from '@archon/paths';
import { APP_VERSION } from '../schema-version';
import { isSqliteBusy } from './sqlite-busy';
import { hasPendingSqliteDataRepairs } from './sqlite-migrations';
import { SQLITE_SCHEMA_DIGEST } from './sqlite-schema-fingerprint.generated';
import { prepareAll, prepareGet } from './sqlite-statements';

function hasFingerprintColumn(db: Database): boolean {
  return prepareAll<{ name: string }>(db, 'PRAGMA table_info(remote_agent_schema_version)').some(
    column => column.name === 'schema_fingerprint'
  );
}

function fingerprint(db: Database): string {
  const cookie = prepareGet<{ schema_version: number }>(db, 'PRAGMA main.schema_version');
  return `sqlite-v1:${SQLITE_SCHEMA_DIGEST}:${APP_VERSION}:${String(cookie?.schema_version)}`;
}

// Call within a read snapshot or the convergence writer: the cookie and the
// data-repair checks must describe the same committed database state.
export function isSqliteSchemaCurrent(db: Database): boolean {
  if (!hasFingerprintColumn(db)) return false;
  const row = prepareGet<{ schema_fingerprint: string | null }>(
    db,
    'SELECT schema_fingerprint FROM remote_agent_schema_version WHERE id = 1'
  );
  return row?.schema_fingerprint === fingerprint(db) && !hasPendingSqliteDataRepairs(db);
}

export function recordSqliteSchemaFingerprint(db: Database, complete: boolean): void {
  try {
    if (hasFingerprintColumn(db)) {
      db.run('UPDATE remote_agent_schema_version SET schema_fingerprint = ? WHERE id = 1', [
        complete ? fingerprint(db) : null,
      ]);
    }
  } catch (error) {
    if (isSqliteBusy(error)) throw error;
    createLogger('db.sqlite').warn(
      { err: error as Error },
      'db.sqlite_schema_fingerprint_record_failed'
    );
  }
}
