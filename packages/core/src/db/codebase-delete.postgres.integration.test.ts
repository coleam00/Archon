// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import { Pool } from 'pg';
import { ActiveContainerEnvironmentsError } from './codebase-delete-error';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';

const baseUrl = process.env.ARCHON_TEST_PG_URL;

test.skipIf(!baseUrl)(
  'PostgreSQL deletion waits for a registering container and refuses it',
  async () => {
    if (!baseUrl) throw new Error('ARCHON_TEST_PG_URL is required');
    const admin = new Pool({ connectionString: baseUrl });
    const scratchName = `archon_codebase_delete_${crypto.randomUUID().replaceAll('-', '')}`;
    let db: PostgresAdapter | undefined;
    let registrar: Pool | undefined;
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
      const { createCodebase, deleteCodebase, getCodebase } = await import('./codebases');
      const project = await createCodebase({
        name: 'delete-test',
        default_cwd: '/repos/delete-test',
      });
      registrar = new Pool({ connectionString: scratchUrl.toString() });
      const client = await registrar.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO remote_agent_isolation_environments
         (codebase_id, workflow_id, workflow_type, provider, working_path, branch_name, status)
         VALUES ($1, 'test', 'workflow', 'container', '/missing', '', 'active')`,
          [project.id]
        );
        const deletion = deleteCodebase(project.id);
        const outcome = deletion.then(
          () => null,
          (error: unknown) => error
        );
        try {
          let blocked = false;
          const deadline = Date.now() + 5000;
          while (!blocked && Date.now() < deadline) {
            const locks = await registrar.query(
              `SELECT pid FROM pg_stat_activity
               WHERE datname = $1 AND wait_event_type = 'Lock'
               AND query = 'SELECT id FROM remote_agent_codebases WHERE id = $1 FOR UPDATE'`,
              [scratchName]
            );
            blocked = locks.rows.length > 0;
          }
          expect(blocked).toBe(true);
        } finally {
          await client.query('COMMIT');
        }
        expect(await outcome).toBeInstanceOf(ActiveContainerEnvironmentsError);
        expect(await getCodebase(project.id)).not.toBeNull();
        expect(
          (
            await adapter.query(
              "SELECT id FROM remote_agent_isolation_environments WHERE status = 'active'"
            )
          ).rows
        ).toHaveLength(1);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    } finally {
      await registrar?.end();
      await db?.close();
      if (created) await admin.query(`DROP DATABASE "${scratchName}"`);
      await admin.end();
    }
  }
);
