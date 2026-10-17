// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import { Pool } from 'pg';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const ROUNDS = 25;

test.skipIf(!baseUrl)(
  'PostgreSQL serializes project storage claims and renames',
  async () => {
    if (!baseUrl) throw new Error('ARCHON_TEST_PG_URL is required');
    const admin = new Pool({ connectionString: baseUrl });
    const scratchName = `archon_codebase_rename_${crypto.randomUUID().replaceAll('-', '')}`;
    let db: PostgresAdapter | undefined;
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${scratchName}"`);
      created = true;
      const scratchUrl = new URL(baseUrl);
      scratchUrl.pathname = `/${scratchName}`;
      db = new PostgresAdapter(scratchUrl.toString());
      const adapter = db;
      mock.module('./connection', () => ({
        pool: adapter,
        getDatabase: () => adapter,
        getDialect: () => postgresDialect,
        getDatabaseType: () => 'postgresql',
      }));
      const codebases = await import('./codebases');

      for (const [index, [name, variant]] of [
        ['acme api', 'Acme API'],
        ['münchen', 'MÜNCHEN'],
      ].entries()) {
        const existing = await codebases.createCodebase({
          name,
          default_cwd: `/repos/case-${index}-existing`,
        });
        const candidate = await codebases.createCodebase({
          name: `candidate-${index}`,
          default_cwd: `/repos/case-${index}-candidate`,
        });

        await expect(codebases.renameCodebase(candidate.id, variant)).rejects.toBeInstanceOf(
          codebases.CodebaseNameTakenError
        );
        expect((await codebases.getCodebase(candidate.id))?.name).toBe(candidate.name);
        expect((await codebases.getCodebase(existing.id))?.name).toBe(name);
        expect((await codebases.renameCodebase(existing.id, variant)).name).toBe(variant);
      }

      const claims = await Promise.allSettled([
        codebases.createCodebase({ name: 'My App', kind: 'folder', default_cwd: '/first' }),
        codebases.createCodebase({ name: 'my-app', kind: 'folder', default_cwd: '/second' }),
      ]);
      expect(claims.filter(claim => claim.status === 'fulfilled')).toHaveLength(1);
      const managed = await Promise.all([
        codebases.createManagedCodebase({
          name: 'acme/api',
          default_cwd: '/first',
          repository_url: 'https://github.com/acme/api',
        }),
        codebases.createManagedCodebase({
          name: 'acme/api',
          default_cwd: '/second',
          repository_url: 'https://gitlab.example/acme/api',
        }),
      ]);
      expect(new Set(managed.map(project => project.name)).size).toBe(2);
      expect(new Set(managed.map(project => project.default_cwd)).size).toBe(2);

      // Under READ COMMITTED, a NOT EXISTS check in two concurrent UPDATEs of
      // different rows sees neither rename; repeat to make an unguarded race show.
      for (let round = 0; round < ROUNDS; round++) {
        const [a, b] = await Promise.all([
          codebases.createCodebase({
            name: `a-${round}`,
            default_cwd: `/repos/${round}/a-${round}`,
          }),
          codebases.createCodebase({
            name: `b-${round}`,
            default_cwd: `/repos/${round}/b-${round}`,
          }),
        ]);
        const target = `qes-${round}`;
        const results = await Promise.allSettled([
          codebases.renameCodebase(a.id, target),
          codebases.renameCodebase(b.id, round % 2 === 0 ? target : target.toUpperCase()),
        ]);
        const rejected = results.filter(r => r.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          codebases.CodebaseNameTakenError
        );
        const owners = await adapter.query<{ id: string }>(
          'SELECT id FROM remote_agent_codebases WHERE LOWER(name) = LOWER($1)',
          [target]
        );
        expect(owners.rows).toHaveLength(1);
      }
    } finally {
      await db?.close();
      if (created) await admin.query(`DROP DATABASE "${scratchName}"`);
      await admin.end();
    }
  },
  60_000
);
