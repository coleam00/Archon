import { expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createSqlStateDocumentStore } from './state-documents';
import type { IDatabase } from './adapters/types';

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
      const input = { project: 'process', name: op, writer: { kind: 'operator', identity: value } };
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
  const rows = await store.listStateRevisions('process', 'patch');
  expect(rows.map(row => row.revision)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  const value = rows[0]?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.seen))
    throw new Error('Missing process ledger');
  expect([...value.seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  const puts = await race('put');
  expect(puts.filter(code => code === 0)).toHaveLength(1);
  expect(puts.filter(code => code === 3)).toHaveLength(7);
  expect(await store.listStateRevisions('process', 'put')).toHaveLength(1);
}
