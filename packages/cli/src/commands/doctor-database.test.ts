import { describe, it, expect } from 'bun:test';
import { checkDatabase, type DatabaseDeps } from './doctor-database';

describe('checkDatabase', () => {
  const schemaVersion = {
    createdAppVersion: '0.5.3',
    appVersion: '0.6.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    appliedAt: '2026-07-01T00:00:00.000Z',
  };

  // Mirrors the makeDeps() helper in doctor-folder-project.test.ts, so each
  // test states only the field it varies.
  function makeDeps(over: Partial<DatabaseDeps> = {}): DatabaseDeps {
    return {
      pool: { query: async () => undefined },
      getDatabaseType: () => 'sqlite',
      getSchemaVersion: async () => schemaVersion,
      ...over,
    };
  }

  it('returns pass when query succeeds', async () => {
    const result = await checkDatabase(async () => makeDeps());
    expect(result.status).toBe('pass');
    expect(result.message).toContain('sqlite');
  });

  it('reports postgres dbType when configured', async () => {
    const result = await checkDatabase(async () => makeDeps({ getDatabaseType: () => 'postgres' }));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('postgres');
  });

  // Schema vintage (#2316): a bug report has to be able to state which build
  // created the database and which last wrote to it.
  it('reports both schema vintages when recorded', async () => {
    const result = await checkDatabase(async () => makeDeps());
    expect(result.message).toContain('schema created by 0.5.3');
    expect(result.message).toContain('last applied by 0.6.0');
  });

  it('says the creation vintage is unknown rather than inventing one', async () => {
    const result = await checkDatabase(async () =>
      makeDeps({ getSchemaVersion: async () => ({ ...schemaVersion, createdAppVersion: null }) })
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('predates version tracking');
    expect(result.message).toContain('last applied by 0.6.0');
  });

  it('reports an unrecorded vintage without failing the check', async () => {
    const result = await checkDatabase(async () =>
      makeDeps({ getSchemaVersion: async () => null })
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('schema vintage not recorded');
  });

  it('stays "pass" when the vintage read throws — the database is still reachable', async () => {
    const result = await checkDatabase(async () =>
      makeDeps({
        getSchemaVersion: async () => {
          throw new Error('no such table: remote_agent_schema_version');
        },
      })
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('reachable (sqlite)');
    expect(result.message).toContain('schema vintage not recorded');
  });

  it('returns fail with "not reachable" when query throws', async () => {
    const result = await checkDatabase(async () =>
      makeDeps({
        pool: {
          query: async () => {
            throw new Error('connection refused');
          },
        },
        getDatabaseType: () => 'postgres',
      })
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('not reachable');
    expect(result.message).toContain('connection refused');
  });

  it('returns fail with "failed to load" when module load throws', async () => {
    const result = await checkDatabase(async () => {
      throw new Error('Cannot find module @archon/core');
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('failed to load database module');
    expect(result.message).toContain('Cannot find module');
  });
});
