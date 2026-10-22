import type { SchemaVersionInfo } from '@archon/core';
import { doctorLog, type CheckResult } from './doctor-check';

export interface DatabaseDeps {
  pool: { query: (sql: string) => Promise<unknown> };
  getDatabaseType: () => string;
  getSchemaVersion: () => Promise<SchemaVersionInfo | null>;
}

/**
 * Render the schema vintage (#2316) for the Database check. A bug report that can
 * state which build created the database — and which last wrote to it — is the whole
 * point, so an unknown or unrecorded vintage is reported as such rather than hidden.
 */
function describeSchemaVersion(info: SchemaVersionInfo | null): string {
  if (!info) return 'schema vintage not recorded';
  const created = info.createdAppVersion ?? '<unknown — predates version tracking>';
  return `schema created by ${created}, last applied by ${info.appVersion}`;
}

export async function checkDatabase(
  // Injected so tests can drive both code paths without mocking the dynamic
  // import. Falls back to the lazy `@archon/core` import in production.
  loadDeps: () => Promise<DatabaseDeps> = loadDatabaseDeps
): Promise<CheckResult> {
  const label = 'Database';
  let deps: DatabaseDeps;
  try {
    deps = await loadDeps();
  } catch (err) {
    // Distinguish module-load failure from query failure — surfacing
    // "not reachable" for an import error misleads the user into running
    // `archon setup` when the real fix is a binary rebuild.
    doctorLog().error({ err }, 'doctor.db_module_load_failed');
    return {
      label,
      status: 'fail',
      message: `failed to load database module: ${(err as Error).message}`,
    };
  }
  try {
    const dbType = deps.getDatabaseType();
    await deps.pool.query('SELECT 1');

    // The vintage is diagnostic metadata: a failure to read it must not turn a
    // reachable database into a failed check. Degrade the message instead.
    let schemaInfo: SchemaVersionInfo | null = null;
    try {
      schemaInfo = await deps.getSchemaVersion();
    } catch (err) {
      doctorLog().warn({ err }, 'doctor.schema_version_read_failed');
    }

    return {
      label,
      status: 'pass',
      message: `reachable (${dbType}); ${describeSchemaVersion(schemaInfo)}`,
    };
  } catch (err) {
    doctorLog().error({ err }, 'doctor.db_query_failed');
    return { label, status: 'fail', message: `not reachable: ${(err as Error).message}` };
  }
}

async function loadDatabaseDeps(): Promise<DatabaseDeps> {
  // Lazy import so doctor doesn't pull in the full @archon/core graph just to
  // print --help or run a different check.
  const { pool, getDatabaseType, getSchemaVersion } = await import('@archon/core');
  return { pool, getDatabaseType, getSchemaVersion };
}
