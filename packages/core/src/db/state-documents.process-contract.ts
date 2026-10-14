import { expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createSqlStateDocumentStore } from './state-documents';
import type { IDatabase } from './adapters/types';
import type { StateScope } from '@archon/workflows/state-document-store';

const processScope: StateScope = { kind: 'project', key: 'process/race' };

export async function assertStateProcessRaces(
  db: IDatabase,
  target: { kind: 'sqlite' | 'postgres'; address: string }
): Promise<void> {
  const script = `
    import { SqliteAdapter } from ${JSON.stringify(fileURLToPath(new URL('./adapters/sqlite.ts', import.meta.url)))};
    import { PostgresAdapter } from ${JSON.stringify(fileURLToPath(new URL('./adapters/postgres.ts', import.meta.url)))};
    import { createSqlStateDocumentStore } from ${JSON.stringify(fileURLToPath(new URL('./state-documents.ts', import.meta.url)))};
    import { StateRevisionConflictError } from '@archon/workflows/state-document-store';
    const [kind, address, op, value] = Bun.argv.slice(1);
    const db = kind === 'sqlite' ? new SqliteAdapter(address) : new PostgresAdapter(address);
    const store = createSqlStateDocumentStore(() => db);
    let code = 0;
    try {
      const input = { scope: { kind: 'project', key: 'process/race' }, name: op, writer: { kind: 'surface', via: 'cli' } };
      if (op === 'put') await store.putStateDocument({ ...input, ifRevision: 0, value: Number(value) });
      else await store.patchStateDocument({ ...input, ops: [{ op: 'append', path: '/seen', value: Number(value) }] });
    } catch (error) {
      if (error instanceof StateRevisionConflictError) code = 3;
      else { console.error(error); code = 1; }
    } finally { await db.close(); }
    process.exit(code);
  `;
  const race = async (op: string): Promise<number[]> => {
    const results = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const child = Bun.spawn(
          [process.execPath, '-e', script, target.kind, target.address, op, String(i)],
          {
            cwd: import.meta.dir,
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
          }
        );
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
        ]);
        return { code, stderr };
      })
    );
    for (const result of results) expect([0, 3], result.stderr).toContain(result.code);
    return results.map(result => result.code);
  };
  const store = createSqlStateDocumentStore(() => db);
  expect(await race('patch')).toEqual(Array(8).fill(0));
  const rows = await store.listStateRevisions(processScope, 'patch');
  expect(rows.map(row => row.revision)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  const value = rows[0]?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.seen))
    throw new Error('Missing process ledger');
  expect([...value.seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  const puts = await race('put');
  expect(puts.filter(code => code === 0)).toHaveLength(1);
  expect(puts.filter(code => code === 3)).toHaveLength(7);
  expect(await store.listStateRevisions(processScope, 'put')).toHaveLength(1);
}

/**
 * Forces the race a patch must survive: after each of writer A's reads of the latest
 * revision, writer B (a second connection) patches the same document before A continues.
 * Six interleavings exceed any bounded retry budget. A backend that blocks B until A
 * commits may let A proceed after a short wait; B's patch then lands afterwards.
 */
export async function assertPatchSurvivesInterleavedWrites(
  db: IDatabase,
  other: IDatabase
): Promise<void> {
  const writerB = createSqlStateDocumentStore(() => other);
  const document = { scope: { kind: 'project', key: 'interleave/race' } as const, name: 'ledger' };
  const started: Promise<unknown>[] = [];
  const interleave =
    (query: IDatabase['query']): IDatabase['query'] =>
    async <T>(sql: string, params?: unknown[]) => {
      const result = await query<T>(sql, params);
      if (started.length < 6 && sql.endsWith('ORDER BY revision DESC LIMIT 1')) {
        const write = writerB.patchStateDocument({
          ...document,
          writer: { kind: 'surface', via: 'cli' },
          ops: [{ op: 'append', path: '/seen', value: `b${started.length}` }],
        });
        started.push(write);
        await Promise.race([write, Bun.sleep(200)]);
      }
      return result;
    };
  const interleaved: Pick<IDatabase, 'dialect' | 'query' | 'withTransaction'> = {
    dialect: db.dialect,
    query: interleave(db.query.bind(db)),
    withTransaction: fn => db.withTransaction(query => fn(interleave(query))),
  };
  const store = createSqlStateDocumentStore(() => interleaved);
  await store.patchStateDocument({
    ...document,
    writer: { kind: 'surface', via: 'cli' },
    ops: [{ op: 'append', path: '/seen', value: 'a' }],
  });
  await Promise.all(started);
  const rows = await store.listStateRevisions(document.scope, document.name);
  expect(rows).toHaveLength(started.length + 1);
  const value = rows[0]?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.seen))
    throw new Error('Missing interleaved ledger');
  expect([...value.seen].sort()).toEqual(['a', ...started.map((_, i) => `b${i}`)].sort());
}
