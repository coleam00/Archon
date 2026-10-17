// @archon-test-isolated
import { toBranchName } from '@archon/git';
import { expect, mock, test } from 'bun:test';
import { Pool } from 'pg';
import {
  ActiveContainerEnvironmentsError,
  ActiveWorktreeEnvironmentsError,
} from './codebase-delete-error';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';

const baseUrl = process.env.ARCHON_TEST_PG_URL;

for (const provider of ['container', 'worktree'] as const) {
  test.skipIf(!baseUrl)(
    `PostgreSQL deletion waits for a registering ${provider} and refuses it`,
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
         VALUES ($1, 'test', 'workflow', $2, '/missing', 'branch', 'active')`,
            [project.id, provider]
          );
          const deletion = deleteCodebase(project.id, { requireWorktreeCleanup: true });
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
          expect(await outcome).toBeInstanceOf(
            provider === 'container'
              ? ActiveContainerEnvironmentsError
              : ActiveWorktreeEnvironmentsError
          );
          expect(await getCodebase(project.id)).not.toBeNull();
          expect(
            (
              await adapter.query(
                "SELECT id FROM remote_agent_isolation_environments WHERE status = 'active'"
              )
            ).rows
          ).toHaveLength(1);
          if (provider === 'worktree') {
            const { listByCodebase, create, markWorktreeDestroyed } = await import(
              './isolation-environments'
            );
            const original = (await listByCodebase(project.id))[0];
            if (!original) throw new Error('Expected registered worktree');
            const replacement = await create({
              codebase_id: project.id,
              workflow_type: original.workflow_type,
              workflow_id: original.workflow_id,
              provider: 'worktree',
              working_path: original.working_path,
              metadata: { ...original.metadata, worktree_creation_id: null },
              branch_name: toBranchName(original.branch_name),
            });
            expect(replacement.id).toBe(original.id);
            await expect(markWorktreeDestroyed(original)).rejects.toThrow('changed during cleanup');
            await expect(
              deleteCodebase(project.id, { requireWorktreeCleanup: true })
            ).rejects.toThrow(original.id);
            const identical = await create({
              codebase_id: project.id,
              workflow_type: replacement.workflow_type,
              workflow_id: replacement.workflow_id,
              working_path: replacement.working_path,
              branch_name: toBranchName(replacement.branch_name),
              metadata: replacement.metadata,
            });
            expect(identical.id).toBe(replacement.id);
            await expect(markWorktreeDestroyed(replacement)).rejects.toThrow(
              'changed during cleanup'
            );
            await expect(
              deleteCodebase(project.id, { requireWorktreeCleanup: true })
            ).rejects.toThrow(identical.id);
            await markWorktreeDestroyed(identical);
            await deleteCodebase(project.id, { requireWorktreeCleanup: true });
            expect(await getCodebase(project.id)).toBeNull();
          }
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
}
