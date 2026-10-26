import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { createLogger } from '@archon/paths';
import { APP_VERSION } from '../schema-version';
import { isSqliteBusy } from './sqlite-busy';
import { hasPendingSqliteDataRepairs, sqliteMigrationSteps } from './sqlite-migrations';
import { prepareAll, prepareGet } from './sqlite-statements';

type StartupStep = (...args: never[]) => unknown;

/**
 * Digest of what a startup convergence executes: the given schema steps, then every
 * migration step, as the running build's source. Bun's transpiler drops code comments,
 * and SQL line comments and layout are removed here, so neither forces a convergence;
 * changing a statement does. Code a convergence never runs is not an input.
 */
export function sqliteStartupDigest(schemaSteps: readonly StartupStep[]): string {
  const hash = createHash('sha256');
  for (const step of [...schemaSteps, ...sqliteMigrationSteps()]) {
    hash
      .update(
        step
          .toString()
          .replace(/^[ \t]*--.*$/gm, '')
          .replace(/\s+/g, ' ')
          .replace(/ ?([^\w ]) ?/g, '$1')
      )
      .update('\0');
  }
  return hash.digest('hex');
}

function hasFingerprintColumn(db: Database): boolean {
  return prepareAll<{ name: string }>(db, 'PRAGMA table_info(remote_agent_schema_version)').some(
    column => column.name === 'schema_fingerprint'
  );
}

function fingerprint(db: Database, digest: string): string {
  const cookie = prepareGet<{ schema_version: number }>(db, 'PRAGMA main.schema_version');
  return `sqlite-v1:${digest}:${APP_VERSION}:${String(cookie?.schema_version)}`;
}

// Call within a read snapshot or the convergence writer: the cookie and the
// data-repair checks must describe the same committed database state.
export function isSqliteSchemaCurrent(db: Database, digest: string): boolean {
  if (!hasFingerprintColumn(db)) return false;
  const row = prepareGet<{ schema_fingerprint: string | null }>(
    db,
    'SELECT schema_fingerprint FROM remote_agent_schema_version WHERE id = 1'
  );
  return row?.schema_fingerprint === fingerprint(db, digest) && !hasPendingSqliteDataRepairs(db);
}

export function recordSqliteSchemaFingerprint(
  db: Database,
  digest: string,
  complete: boolean
): void {
  try {
    if (hasFingerprintColumn(db)) {
      db.run('UPDATE remote_agent_schema_version SET schema_fingerprint = ? WHERE id = 1', [
        complete ? fingerprint(db, digest) : null,
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
