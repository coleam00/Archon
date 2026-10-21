// @archon-test-isolated
import { checkoutEnvironmentReferences } from '@archon/workflows/schemas/checkout-ownership';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolationResolver, registerWorktree, WorktreeProvider } from '@archon/isolation';
import { toRepoPath, toBranchName, execFileAsync } from '@archon/git';
import { Database, SQLiteError } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { removeTempTree } from '@archon/paths/test-utils';
import { commit } from '@archon/workflows/file-store';
import { WorktreeInUseError } from '@archon/isolation/types';
import { createFileWorkflowHost } from '../workflows/file-host';
import { createSqlWorkflowHost } from '../workflows/sql-host';
import { drainResourceStartHost, ResourceStartDrainError } from '../workflows/resource-start-host';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';
import type { IDatabase } from './adapters/types';

const root = await mkdtemp(join(tmpdir(), 'registration-conformance-'));
const pgUrl = process.env.ARCHON_TEST_PG_URL;
const scratchName = `archon_registration_${randomUUID().replaceAll('-', '')}`;
let admin: import('pg').Pool | undefined;
let db: IDatabase;
let transactionDb: IDatabase | undefined;
let dialect = sqliteDialect;
if (pgUrl) {
  const { Pool } = await import('pg');
  admin = new Pool({ connectionString: pgUrl });
  await admin.query(`CREATE DATABASE "${scratchName}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${scratchName}`;
  const { PostgresAdapter, postgresDialect } = await import('./adapters/postgres');
  db = new PostgresAdapter(url.toString());
  dialect = postgresDialect;
} else {
  db = new SqliteAdapter(join(root, 'ownership.db'));
}
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => transactionDb ?? db,
  getDialect: () => dialect,
  getDatabaseType: () => (pgUrl ? 'postgresql' : 'sqlite'),
}));
const sql = await import('./isolation-environments');
const { createWorkflowStore } = await import('../workflows/store-adapter');
const { updateConversation, clearConversationCheckout, getConversationById } = await import(
  './conversations'
);
const prior = Object.fromEntries(
  ['ARCHON_HOME', 'DATABASE_URL', 'GITHUB_APP_ID'].map(key => [key, process.env[key]])
);
process.env.ARCHON_HOME = root;
process.env.DATABASE_URL = '';
process.env.GITHUB_APP_ID = '';
const fileRoot = join(root, 'store');
const fileHost = await createFileWorkflowHost(fileRoot);
const file = fileHost.records.isolation;
afterAll(async () => {
  await db.close();
  if (admin) {
    await admin.query(`DROP DATABASE "${scratchName}" WITH (FORCE)`);
    await admin.end();
  }
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeTempTree(root);
});

const sqlStore = createWorkflowStore();
for (const kind of ['sql', 'files'] as const) {
  const store = kind === 'sql' ? sqlStore : fileHost.deps.store;
  const isolation = kind === 'sql' ? sql.createIsolationStore() : file;
  async function fixture() {
    const codebase = randomUUID();
    if (kind === 'sql')
      await db.query(
        'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
        [codebase, codebase, root]
      );
    const env = await isolation.create({
      codebase_id: codebase,
      workflow_type: 'task',
      workflow_id: codebase,
      working_path: join(root, codebase),
      branch_name: toBranchName(codebase),
      metadata: {},
    });
    const create = (data: Partial<Parameters<typeof store.createWorkflowRun>[0]> = {}) =>
      store.createWorkflowRun({
        workflow_name: 'ownership',
        user_message: '',
        codebase_id: codebase,
        ...data,
      });
    return { env, create };
  }

  for (const channel of ['path', 'metadata', 'owned'] as const) {
    for (const status of ['pending', 'running', 'paused', 'failed'] as const) {
      test(`${kind}: ${status} ${channel} owner vetoes claim before destruction`, async () => {
        const { env, create } = await fixture();
        const run = await create(
          channel === 'path'
            ? { working_path: env.working_path }
            : {
                metadata:
                  channel === 'metadata'
                    ? { isolation_env_id: env.id }
                    : { owned_worktree: { envId: env.id } },
              }
        );
        if (status !== 'pending') {
          await store.claimPendingWorkflowRun(run.id);
          if (status === 'failed') await store.failWorkflowRun(run.id, 'original error');
          if (status === 'paused') await store.updateWorkflowRun(run.id, { status: 'paused' });
        }
        let destroyed = false;
        await expect(
          isolation.withWorktreeRegistration(env, async mark => {
            destroyed = true;
            await mark();
          })
        ).rejects.toBeInstanceOf(WorktreeInUseError);
        expect(destroyed).toBe(false);
        expect((await isolation.getById(env.id))?.status).toBe('active');
      });
    }
  }

  test.each(['metadata', 'owned', ...(kind === 'sql' ? ['conversation'] : [])])(
    `${kind}: pending %s alias owner protects every registration of the checkout`,
    async channel => {
      const { env, create } = await fixture();
      const alias = await isolation.create({
        codebase_id: env.codebase_id,
        workflow_type: 'task',
        workflow_id: randomUUID(),
        working_path: env.working_path,
        branch_name: toBranchName(env.branch_name),
      });
      let origin;
      if (channel === 'conversation') {
        const conversationId = randomUUID();
        await db.query(
          `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id) VALUES ($1, 'cli', $2, $3)`,
          [conversationId, conversationId, alias.id]
        );
        origin = { conversationId };
      }
      await create({
        origin,
        metadata:
          channel === 'metadata'
            ? { isolation_env_id: alias.id }
            : channel === 'owned'
              ? { owned_worktree: { envId: alias.id } }
              : {},
      });
      await expect(
        isolation.withWorktreeRegistration(env, async mark => mark())
      ).rejects.toBeInstanceOf(WorktreeInUseError);
    }
  );

  test.each(['pending', 'running', 'paused', 'failed'] as const)(
    `${kind}: direct ghost retirement cannot bypass a %s owner`,
    async status => {
      const { env, create } = await fixture();
      const run = await create({ metadata: { isolation_env_id: env.id } });
      if (status !== 'pending') await store.claimPendingWorkflowRun(run.id);
      if (status === 'paused') await store.updateWorkflowRun(run.id, { status });
      if (status === 'failed') await store.failWorkflowRun(run.id, 'preserved');
      await expect(isolation.markWorktreeDestroyed(env)).rejects.toBeInstanceOf(WorktreeInUseError);
      expect((await isolation.getById(env.id))?.status).toBe('active');
    }
  );

  test(`${kind}: retiring an already retired registration preserves a later alias owner`, async () => {
    const { env, create } = await fixture();
    await isolation.markWorktreeDestroyed(env);
    const alias = await isolation.create({
      codebase_id: env.codebase_id,
      workflow_type: 'task',
      workflow_id: randomUUID(),
      working_path: env.working_path,
      branch_name: toBranchName(env.branch_name),
    });
    await create({ metadata: { isolation_env_id: alias.id } });
    await isolation.markWorktreeDestroyed(env);
    expect((await isolation.getById(alias.id))?.status).toBe('active');
  });

  test.each(['branch', 'provider'] as const)(
    `${kind}: %s adoption cannot publish a checkout removed before registration`,
    async route => {
      const { env, create } = await fixture();
      const run = await create({ working_path: env.working_path });
      await store.failWorkflowRun(run.id, 'preserved');
      await mkdir(join(env.working_path, '.git'), { recursive: true });
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const cleanup = isolation.withWorktreeRegistration(
        env,
        async mark => {
          entered.resolve();
          await finish.promise;
          await removeTempTree(env.working_path);
          await mark();
        },
        { runOwnership: { releaseFailed: { kind: 'settled' } } }
      );
      await entered.promise;
      const record = {
        codebase_id: env.codebase_id,
        workflow_type: 'pr' as const,
        workflow_id: randomUUID(),
      };
      const adoption =
        route === 'branch'
          ? isolation.create({
              ...record,
              working_path: env.working_path,
              branch_name: toBranchName(env.branch_name),
              metadata: { adopted: true },
            })
          : registerWorktree(
              {
                store: isolation,
                registrationsBeforeCreation: [env],
                provider: {
                  destroy: async () => {
                    throw new Error('adopted worktrees must never be rolled back');
                  },
                },
              },
              {
                id: env.working_path,
                provider: 'worktree',
                workingPath: env.working_path,
                branchName: toBranchName(env.branch_name),
                status: 'active',
                createdAt: new Date(),
                metadata: { provenance: 'adopted', adopted: true },
              },
              toRepoPath(root),
              record
            );
      const outcome = Promise.allSettled([adoption]);
      finish.resolve();
      await cleanup;
      await expect(adoption).rejects.toThrow(env.working_path);
      await outcome;
      const before = await store.getWorkflowRun(run.id);
      const events = await store.listWorkflowEvents(run.id);
      await expect(store.resumeWorkflowRun(run.id)).rejects.toThrow('start a fresh run');
      expect(await store.getWorkflowRun(run.id)).toEqual(before);
      expect(await store.listWorkflowEvents(run.id)).toEqual(events);
    }
  );

  test(`${kind}: published adoption and its pending owner win before retirement`, async () => {
    const { env, create } = await fixture();
    await mkdir(join(env.working_path, '.git'), { recursive: true });
    const alias = await isolation.create({
      codebase_id: env.codebase_id,
      workflow_type: 'pr',
      workflow_id: randomUUID(),
      working_path: env.working_path,
      branch_name: toBranchName(env.branch_name),
      metadata: { adopted: true },
    });
    await create({ metadata: { isolation_env_id: alias.id } });
    await expect(
      isolation.withWorktreeRegistration(env, async mark => mark())
    ).rejects.toBeInstanceOf(WorktreeInUseError);
  });

  test(`${kind}: activation and resume winning first block every cleanup release policy`, async () => {
    for (const status of ['pending', 'running', 'paused'] as const) {
      for (const releaseFailed of [{ kind: 'settled' }, { kind: 'stale', staleDays: 1 }] as const) {
        const { env, create } = await fixture();
        const run = await create();
        await store.updateWorkflowRun(run.id, { working_path: env.working_path });
        if (status !== 'pending') await store.claimPendingWorkflowRun(run.id);
        if (status === 'paused') await store.updateWorkflowRun(run.id, { status });
        await expect(
          isolation.withWorktreeRegistration(env, async mark => mark(), {
            runOwnership: { releaseFailed },
          })
        ).rejects.toBeInstanceOf(WorktreeInUseError);
      }
    }
    const { env, create } = await fixture();
    const failed = await create({ working_path: env.working_path });
    await store.failWorkflowRun(failed.id, 'failed');
    await store.resumeWorkflowRun(failed.id);
    await expect(
      isolation.withWorktreeRegistration(env, async mark => mark(), {
        runOwnership: { releaseFailed: { kind: 'settled' } },
      })
    ).rejects.toBeInstanceOf(WorktreeInUseError);
  });

  test(`${kind}: settled failures release, but do not hide another owner`, async () => {
    const { env, create } = await fixture();
    const pending = await create({ working_path: env.working_path });
    const failed = await create({ working_path: env.working_path });
    await store.failWorkflowRun(failed.id, 'old error');
    const policy = { runOwnership: { releaseFailed: { kind: 'settled' as const } } };
    await expect(
      isolation.withWorktreeRegistration(env, async mark => mark(), policy)
    ).rejects.toBeInstanceOf(WorktreeInUseError);
    await store.cancelWorkflowRun(pending.id);
    const before = await store.getWorkflowRun(failed.id);
    const events = await store.listWorkflowEvents(failed.id);
    await isolation.withWorktreeRegistration(env, async mark => mark(), policy);
    await expect(store.resumeWorkflowRun(failed.id)).rejects.toThrow(
      `Checkout '${env.working_path}' was released; start a fresh run.`
    );
    expect(await store.getWorkflowRun(failed.id)).toEqual(before);
    expect(await store.listWorkflowEvents(failed.id)).toEqual(events);
    await store.updateWorkflowRun(failed.id, {
      working_path: before?.working_path ?? undefined,
      metadata: { ...before?.metadata, note: 'audit still writable' },
    });
    expect((await store.getWorkflowRun(failed.id))?.metadata.note).toBe('audit still writable');
  });

  test(`${kind}: retirement refuses every association and execution entry without mutations`, async () => {
    const { env, create } = await fixture();
    const pathRun = await create();
    const metaRun = await create();
    const failed = await create({ metadata: { isolation_env_id: env.id } });
    await store.failWorkflowRun(failed.id, 'preserved');
    const cancelled = await create({ working_path: env.working_path });
    await store.cancelFanOutRun(cancelled.id, 'fan_out_sibling');
    await isolation.withWorktreeRegistration(env, async mark => mark(), {
      runOwnership: { releaseFailed: { kind: 'settled' } },
    });
    const actions = [
      () => create({ working_path: env.working_path }),
      () => create({ metadata: { isolation_env_id: env.id } }),
      () => create({ metadata: { owned_worktree: { envId: env.id } } }),
      () => store.updateWorkflowRun(pathRun.id, { working_path: env.working_path }),
      () => store.updateWorkflowRun(metaRun.id, { metadata: { isolation_env_id: env.id } }),
      () =>
        store.updateWorkflowRun(metaRun.id, { metadata: { owned_worktree: { envId: env.id } } }),
      () => store.resumeWorkflowRun(failed.id),
      () => store.recoverCancelledFanOutRun(cancelled.id),
    ];
    for (const action of actions) {
      const before = await Promise.all(
        [pathRun, metaRun, failed, cancelled].map(run => store.getWorkflowRun(run.id))
      );
      const events = await store.listWorkflowEvents(cancelled.id);
      await expect(action()).rejects.toThrow(env.working_path);
      expect(
        await Promise.all(
          [pathRun, metaRun, failed, cancelled].map(run => store.getWorkflowRun(run.id))
        )
      ).toEqual(before);
      expect(await store.listWorkflowEvents(cancelled.id)).toEqual(events);
    }
    expect(await store.claimPendingWorkflowRun(pathRun.id, env.working_path)).toBeNull();
    const unmanaged = await create({ working_path: join(root, randomUUID()) });
    expect(await store.claimPendingWorkflowRun(unmanaged.id, env.working_path)).toMatchObject({
      working_path: unmanaged.working_path,
      status: 'running',
    });
    await store.updateWorkflowRun(unmanaged.id, { working_path: env.working_path });
    expect((await store.getWorkflowRun(unmanaged.id))?.working_path).toBe(unmanaged.working_path);
    await expect(
      store.updateWorkflowRunMetadataIfRunning(unmanaged.id, { isolation_env_id: env.id })
    ).rejects.toThrow(env.working_path);
    expect((await store.getWorkflowRun(unmanaged.id))?.metadata).toEqual({});
    const active = await isolation.create({
      codebase_id: env.codebase_id,
      working_path: env.working_path,
      workflow_type: env.workflow_type,
      workflow_id: randomUUID(),
      branch_name: toBranchName(env.branch_name),
      metadata: {},
    });
    expect(active.working_path).toBe(env.working_path);
    expect(await store.claimPendingWorkflowRun(pathRun.id, env.working_path)).toMatchObject({
      status: 'running',
    });
    await store.resumeWorkflowRun(failed.id);
  });

  for (const age of [
    'old',
    'recent',
    'missing',
    ...(kind === 'sql' && !pgUrl ? ['malformed'] : []),
  ]) {
    test(`${kind}: stale policy ${age} failure preserves audit`, async () => {
      const { env, create } = await fixture();
      const run = await create({ working_path: env.working_path });
      await store.failWorkflowRun(run.id, 'old failure');
      const time = age === 'old' ? new Date('2000-01-01T00:00:00Z') : new Date();
      if (kind === 'sql')
        await db.query(
          'UPDATE remote_agent_workflow_runs SET completed_at = $2, last_activity_at = NULL, started_at = $3 WHERE id = $1',
          [
            run.id,
            age === 'malformed' ? 'unparseable' : age === 'missing' ? null : time.toISOString(),
            time.toISOString(),
          ]
        );
      else
        await commit(fileRoot, [run.id], async runs => {
          const stored = runs.get(run.id)!;
          stored.completed_at = age === 'missing' ? null : time;
          stored.last_activity_at = null;
          stored.started_at = time;
          return { result: undefined, changes: { runs: [{ run: stored, events: [] }] } };
        });
      const events = await store.listWorkflowEvents(run.id);
      const cleanup = isolation.withWorktreeRegistration(env, async mark => mark(), {
        runOwnership: { releaseFailed: { kind: 'stale', staleDays: 14 } },
      });
      if (age === 'old') await cleanup;
      else await expect(cleanup).rejects.toBeInstanceOf(WorktreeInUseError);
      expect(await store.listWorkflowEvents(run.id)).toEqual(events);
    });
  }

  test.each(['failed', 'paused'] as const)(
    `${kind}: retired checkout resume preserves %s state and resource admission`,
    async state => {
      const { env } = await fixture();
      const id = randomUUID();
      const resource = randomUUID();
      expect(
        await store.admitResourceStart({
          resource,
          hostId: 'ownership',
          capacity: 1,
          overlap: 'queue',
          launch: {
            version: 2,
            run: {
              id,
              workflow_name: 'admitted',
              user_message: '',
              codebase_id: env.codebase_id,
              working_path: env.working_path,
              metadata: {},
            },
            execution: {
              cwd: env.working_path,
              conversationId: 'ownership',
              isolation: { kind: 'in-place' },
            },
          },
        })
      ).toMatchObject({ status: 'admitted' });
      await store.claimPendingWorkflowRun(id);
      if (state === 'failed') await store.failWorkflowRun(id, 'preserved error');
      else await store.updateWorkflowRun(id, { status: 'paused' });
      await store.updateWorkflowRun(id, {
        metadata: {
          scheduled_resume: {
            reason: 'quota',
            resumeAt: '2026-01-01T00:00:00Z',
            deadlineAt: '2026-01-02T00:00:00Z',
            attempt: 1,
            maxAttempts: 2,
          },
        },
      });
      await isolation.withWorktreeRegistration(
        env,
        async mark => mark(),
        state === 'failed'
          ? { runOwnership: { releaseFailed: { kind: 'settled' } } }
          : { runOwnership: false }
      );
      const slots = async () => {
        if (kind === 'sql')
          return (
            await db.query(
              'SELECT * FROM remote_agent_resource_slot_holders ORDER BY resource_key, holder_id'
            )
          ).rows;
        const directory = join(fileRoot, 'resource/slots');
        return Promise.all(
          (await readdir(directory)).sort().map(name => readFile(join(directory, name), 'utf8'))
        );
      };
      const beforeSlots = await slots();
      const before = await store.getWorkflowRun(id);
      const events = await store.listWorkflowEvents(id);
      const request = await store.getResourceStartRequest(id);
      await expect(store.resumeWorkflowRun(id)).rejects.toThrow(env.working_path);
      expect(await store.getWorkflowRun(id)).toEqual(before);
      expect(await store.listWorkflowEvents(id)).toEqual(events);
      expect(await store.getResourceStartRequest(id)).toEqual(request);
      expect(await slots()).toEqual(beforeSlots);
    }
  );

  test.each(['direct', 'drain', 'binding'] as const)(
    `${kind}: retired checkout refuses %s admission atomically`,
    async operation => {
      const { env } = await fixture();
      const resource = randomUUID();
      const launch: PreparedWorkflowLaunch = {
        version: 2,
        run: {
          id: randomUUID(),
          workflow_name: 'late-admission',
          codebase_id: env.codebase_id,
          user_message: '',
          working_path: env.working_path,
          metadata: {},
        },
        execution: {
          cwd: env.working_path,
          conversationId: 'admission',
          isolation: { kind: 'in-place' },
        },
      };
      const intent = {
        resource,
        capacity: 1,
        hostId: 'ownership',
        overlap: 'queue' as const,
        launch,
      };
      let acquire = () => store.admitResourceStart(intent);
      if (operation === 'drain') {
        const holder = {
          ...launch,
          run: { ...launch.run, id: randomUUID(), working_path: join(root, randomUUID()) },
        };
        holder.execution = { ...launch.execution, cwd: holder.run.working_path };
        await store.admitResourceStart({ ...intent, launch: holder });
        expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'queued' });
        await store.cancelWorkflowRun(holder.run.id);
        acquire = async () => {
          const result = (await store.drainResourceStarts({ resource, hostId: 'ownership' }))[0]!;
          expect(result).toMatchObject({ status: 'failed', requestId: launch.run.id });
          if (result.status === 'failed') throw result.error;
          return result;
        };
      }
      if (operation === 'binding') {
        const receiptId = randomUUID();
        const bindingId = 'binding';
        await store.acceptStartReceipt({
          receipt: {
            id: receiptId,
            sourceInstanceId: randomUUID(),
            deliveryId: null,
            contentDigest: 'local',
            receivedAt: new Date().toISOString(),
            occurredAt: null,
            sourceActor: null,
          },
          outcome: 'matched',
          bindings: [
            {
              bindingId,
              bindingRevision: '1',
              hostId: 'ownership',
              runAsUserId: randomUUID(),
              resource,
              capacity: 1,
              overlap: 'queue',
              launch: {
                cwd: env.working_path,
                workflowName: launch.run.workflow_name,
                inputs: {},
                isolation: { kind: 'in-place' },
              },
            },
          ],
        });
        await store.claimStartBindingPreparation({ receiptId, bindingId, ownerId: 'owner' });
        acquire = async () =>
          (await store.completeStartBindingPreparation({
            receiptId,
            bindingId,
            ownerId: 'owner',
            launch,
          }))!;
      }
      await isolation.withWorktreeRegistration(env, async mark => mark());
      const before = await store.getResourceStartRequest(launch.run.id);
      await expect(acquire()).rejects.toThrow(env.working_path);
      expect(await store.getWorkflowRun(launch.run.id)).toBeNull();
      expect(await store.getResourceStartRequest(launch.run.id)).toEqual(before);
    }
  );

  test.each(['pending', 'running', 'paused'] as const)(
    `${kind}: rollback retains a checkout acquired by a %s run`,
    async status => {
      const { env, create } = await fixture();
      const run = await create({ working_path: env.working_path });
      if (status !== 'pending') await store.claimPendingWorkflowRun(run.id);
      if (status === 'paused') await store.updateWorkflowRun(run.id, { status });
      const before = await store.getWorkflowRun(run.id);
      const events = await store.listWorkflowEvents(run.id);
      const destroy = mock(async () => ({
        worktreeRemoved: true,
        directoryClean: true,
        branchDeleted: null,
        remoteBranchDeleted: null,
        warnings: [],
      }));
      const resolver = new IsolationResolver({
        store: isolation,
        provider: {
          providerType: 'worktree',
          destroy,
          create: async () => {
            throw new Error('unexpected create');
          },
          get: async () => null,
          list: async () => [],
          healthCheck: async () => true,
        },
      });
      await resolver.releaseUnlinked({
        status: 'resolved',
        env,
        cwd: env.working_path,
        method: {
          type: 'created',
          creationId: randomUUID(),
          canonicalRepoPath: toRepoPath(root),
          branchCreated: true,
        },
      });
      expect(destroy).not.toHaveBeenCalled();
      expect((await isolation.getById(env.id))?.status).toBe('active');
      expect(await store.getWorkflowRun(run.id)).toEqual(before);
      expect(await store.listWorkflowEvents(run.id)).toEqual(events);
    }
  );

  test(`${kind}: a retired queued checkout leaves independent starts admissible`, async () => {
    const { env } = await fixture();
    const resource = randomUUID();
    const launch = (path: string): PreparedWorkflowLaunch => ({
      version: 2,
      run: {
        id: randomUUID(),
        codebase_id: env.codebase_id,
        workflow_name: 'queued',
        user_message: '',
        working_path: path,
        metadata: {},
      },
      execution: { cwd: path, conversationId: 'queue', isolation: { kind: 'in-place' } },
    });
    const intent = { resource, capacity: 1, hostId: resource, overlap: 'queue' as const };
    const holder = launch(join(root, randomUUID()));
    const retired = launch(env.working_path);
    const valid = launch(join(root, randomUUID()));
    await store.admitResourceStart({ ...intent, launch: holder });
    expect(await store.admitResourceStart({ ...intent, launch: retired })).toMatchObject({
      status: 'queued',
    });
    expect(await store.admitResourceStart({ ...intent, launch: valid })).toMatchObject({
      status: 'queued',
    });
    await store.cancelWorkflowRun(holder.run.id);
    await isolation.withWorktreeRegistration(env, async mark => mark());
    const before = await store.getResourceStartRequest(retired.run.id);
    const host = kind === 'sql' ? createSqlWorkflowHost() : fileHost;
    const started: string[] = [];
    const failure = await drainResourceStartHost({
      ...host,
      hostId: resource,
      startAdmitted: async id => {
        started.push(id);
      },
    }).catch((error: unknown) => error);
    expect(started).toEqual([valid.run.id]);
    expect(failure).toBeInstanceOf(ResourceStartDrainError);
    if (!(failure instanceof ResourceStartDrainError)) throw new Error('expected drain failure');
    expect(failure.failures).toMatchObject([
      { error: { message: expect.stringContaining(env.working_path) } },
    ]);
    expect(await store.getResourceStartRequest(retired.run.id)).toEqual(before);
    expect(await store.getWorkflowRun(retired.run.id)).toBeNull();
    expect((await store.getWorkflowRun(valid.run.id))?.status).toBe('pending');
    expect(await store.claimPendingWorkflowRun(valid.run.id)).not.toBeNull();
  });

  async function independentStore() {
    if (kind === 'files')
      return { peer: (await createFileWorkflowHost(fileRoot)).deps.store, secondary: undefined };
    let secondary: IDatabase;
    if (!pgUrl) secondary = new SqliteAdapter(join(root, 'ownership.db'));
    else {
      const { PostgresAdapter } = await import('./adapters/postgres');
      const url = new URL(pgUrl);
      url.pathname = `/${scratchName}`;
      secondary = new PostgresAdapter(url.toString());
    }
    await secondary.query('SELECT 1');
    if (!pgUrl) await secondary.query('PRAGMA busy_timeout = 0');
    return { peer: store, secondary };
  }

  test(`${kind}: retirement holding exclusion wins against activation and resume from a second host`, async () => {
    const { env, create } = await fixture();
    const pending = await create();
    const failed = await create({ working_path: env.working_path });
    await store.failWorkflowRun(failed.id, 'preserve this error');
    const before = await store.getWorkflowRun(failed.id);
    const events = await store.listWorkflowEvents(failed.id);
    const { peer, secondary } = await independentStore();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const cleanup = isolation.withWorktreeRegistration(
      env,
      async mark => {
        if (kind === 'sql' && !pgUrl) {
          const probe = new Database(join(root, 'ownership.db'));
          try {
            probe.run('PRAGMA busy_timeout = 0');
            expect(() =>
              probe.run(
                'UPDATE remote_agent_isolation_environments SET status = status WHERE 1 = 0'
              )
            ).toThrow(SQLiteError);
          } finally {
            probe.close();
          }
        }
        if (kind === 'sql' && pgUrl) {
          const result = await secondary!.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_xact_lock(1797) AS acquired'
          );
          expect(result.rows[0]?.acquired).toBe(false);
        }
        entered.resolve();
        await finish.promise;
        await mark();
      },
      { runOwnership: { releaseFailed: { kind: 'settled' } } }
    );
    await entered.promise;
    transactionDb = secondary;
    const claim = peer.claimPendingWorkflowRun(pending.id, env.working_path);
    const resume = peer.resumeWorkflowRun(failed.id);
    const outcomes = Promise.allSettled([claim, resume]);
    finish.resolve();
    try {
      await cleanup;
      expect(await claim).toBeNull();
      await expect(resume).rejects.toThrow(env.working_path);
      await outcomes;
      expect(await store.getWorkflowRun(failed.id)).toEqual(before);
      expect(await store.listWorkflowEvents(failed.id)).toEqual(events);
    } finally {
      transactionDb = undefined;
      await secondary?.close();
    }
  });

  if (kind === 'sql')
    test('SQL conversation linking waits behind retirement on a second connection', async () => {
      const { env, create } = await fixture();
      const conversationId = randomUUID();
      await db.query(
        `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'cli', $2)`,
        [conversationId, conversationId]
      );
      const run = await create({ origin: { conversationId } });
      const before = await store.getWorkflowRun(run.id);
      const events = await store.listWorkflowEvents(run.id);
      const { secondary } = await independentStore();
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const attempt = Promise.withResolvers<void>();
      let linkerPid: number | undefined;
      const transact = secondary!.withTransaction.bind(secondary);
      const transactionSpy = spyOn(secondary!, 'withTransaction').mockImplementation(
        (fn, options) =>
          transact(async query => {
            if (pgUrl)
              linkerPid = (await query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
                .pid;
            return fn(<U>(sql: string, params?: unknown[]) => {
              const result = query<U>(sql, params);
              attempt.resolve();
              return result;
            });
          }, options)
      );
      const cleanup = isolation.withWorktreeRegistration(env, async mark => {
        entered.resolve();
        await finish.promise;
        await mark();
      });
      await entered.promise;
      transactionDb = secondary;
      const linking = updateConversation(conversationId, { isolation_env_id: env.id });
      const result = Promise.allSettled([linking]);
      try {
        await attempt.promise;
        if (pgUrl) {
          let blocked = false;
          for (let i = 0; i < 100; i++) {
            const state = await db.query<{ blocked: boolean }>(
              'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
              [linkerPid]
            );
            if (state.rows[0]?.blocked) {
              blocked = true;
              break;
            }
            await Bun.sleep(10);
          }
          expect(blocked).toBe(true);
        }
        finish.resolve();
        await cleanup;
        await expect(linking).rejects.toThrow(env.working_path);
        expect(
          (
            await db.query<{ isolation_env_id: string | null }>(
              'SELECT isolation_env_id FROM remote_agent_conversations WHERE id = $1',
              [conversationId]
            )
          ).rows[0]?.isolation_env_id
        ).toBeNull();
        expect(await store.getWorkflowRun(run.id)).toEqual(before);
        expect(await store.listWorkflowEvents(run.id)).toEqual(events);
      } finally {
        finish.resolve();
        await cleanup;
        await result;
        transactionDb = undefined;
        transactionSpy.mockRestore();
        await secondary?.close();
      }
    });

  test(`${kind}: an explicit registration-only claim preserves the force override`, async () => {
    const { env, create } = await fixture();
    await create({ working_path: env.working_path });
    await isolation.withWorktreeRegistration(env, async mark => mark(), { runOwnership: false });
    expect((await isolation.getById(env.id))?.status).toBe('destroyed');
  });
}

test('SQL conversation association is checked under the same checkout exclusion', async () => {
  const codebase = randomUUID();
  await db.query('INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)', [
    codebase,
    codebase,
    root,
  ]);
  const env = await sql.create({
    codebase_id: codebase,
    workflow_type: 'task',
    workflow_id: codebase,
    working_path: join(root, codebase),
    branch_name: toBranchName(codebase),
    metadata: {},
  });
  const conversationId = randomUUID();
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'cli', $2)`,
    [conversationId, conversationId]
  );
  const run = await sqlStore.createWorkflowRun({
    workflow_name: 'conversation',
    user_message: '',
    origin: { conversationId },
  });
  await updateConversation(conversationId, { isolation_env_id: env.id });
  await expect(sql.withWorktreeRegistration(env, async mark => mark())).rejects.toBeInstanceOf(
    WorktreeInUseError
  );
  await sqlStore.cancelWorkflowRun(run.id);
  await sql.withWorktreeRegistration(env, async mark => mark());
  await expect(
    sqlStore.createWorkflowRun({
      workflow_name: 'late-conversation',
      user_message: '',
      origin: { conversationId },
    })
  ).rejects.toThrow(env.working_path);
  await updateConversation(conversationId, { isolation_env_id: null });
  await expect(updateConversation(conversationId, { isolation_env_id: env.id })).rejects.toThrow(
    env.working_path
  );
});

test.each(
  [false, true].flatMap(replacement =>
    ['matching', 'override', 'absent'].map(cwd => ({ replacement, cwd }))
  )
)(
  'SQL conditional checkout clear preserves $cwd cwd and replacement=$replacement',
  async ({ replacement, cwd }) => {
    const codebase = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [codebase, codebase, root]
    );
    const createEnv = () =>
      sql.create({
        codebase_id: codebase,
        workflow_type: 'task',
        workflow_id: randomUUID(),
        working_path: join(root, randomUUID()),
        branch_name: toBranchName(randomUUID()),
        metadata: {},
      });
    const retired = await createEnv();
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id) VALUES ($1, 'cli', $2, $3)`,
      [conversationId, conversationId, retired.id]
    );
    await sql.withWorktreeRegistration(retired, async mark => mark());
    const current = replacement ? await createEnv() : null;
    if (current) await updateConversation(conversationId, { isolation_env_id: current.id });
    const run = current
      ? await sqlStore.createWorkflowRun({
          workflow_name: 'pending-owner',
          user_message: '',
          origin: { conversationId },
        })
      : null;
    const previousCwd =
      cwd === 'matching' ? retired.working_path : cwd === 'override' ? root : null;
    await updateConversation(conversationId, { cwd: previousCwd });
    const conversation = await clearConversationCheckout(conversationId, retired.id);
    expect(conversation.cwd).toBe(!replacement && cwd === 'matching' ? null : previousCwd);
    expect(conversation.isolation_env_id).toBe(current?.id ?? null);
    expect((await getConversationById(conversationId))?.isolation_env_id).toBe(current?.id ?? null);
    if (current && run) {
      await expect(
        sql.withWorktreeRegistration(current, async mark => mark())
      ).rejects.toBeInstanceOf(WorktreeInUseError);
      expect((await sqlStore.getWorkflowRun(run.id))?.status).toBe('pending');
    }
  }
);

test('SQL conditional checkout clear refuses a missing conversation', async () => {
  await expect(clearConversationCheckout(randomUUID(), randomUUID())).rejects.toThrow(
    'Conversation not found:'
  );
});

test.each(
  (['pending', 'running', 'paused', 'failed', 'cancelled', 'completed'] as const).flatMap(status =>
    (['clear', 'rebind', 'attach'] as const).map(change => ({ status, change }))
  )
)(
  'SQL conversation $change snapshots only execution-capable legacy runs: $status',
  async ({ status, change }) => {
    const codebase = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [codebase, codebase, root]
    );
    const createEnv = () =>
      sql.create({
        codebase_id: codebase,
        workflow_type: 'task',
        workflow_id: randomUUID(),
        working_path: join(root, randomUUID()),
        branch_name: toBranchName(randomUUID()),
      });
    const env = await createEnv();
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id) VALUES ($1, 'cli', $2, $3)`,
      [conversationId, conversationId, change === 'attach' ? null : env.id]
    );
    const run = await sqlStore.createWorkflowRun({
      workflow_name: 'legacy',
      user_message: '',
      origin: { conversationId },
    });
    await db.query(
      'UPDATE remote_agent_workflow_runs SET status = $2, metadata = $3 WHERE id = $1',
      [run.id, status, JSON.stringify({ retained: true })]
    );
    if (change === 'clear') await clearConversationCheckout(conversationId, env.id);
    else
      await updateConversation(conversationId, {
        isolation_env_id: change === 'attach' ? env.id : (await createEnv()).id,
      });
    expect((await sqlStore.getWorkflowRun(run.id))?.metadata).toEqual(
      status === 'completed' ? { retained: true } : { retained: true, isolation_env_id: env.id }
    );
    expect((await sqlStore.getWorkflowRun(run.id))?.status).toBe(status);
  }
);

test.each(['path', 'metadata', 'owned'] as const)(
  'SQL resume prefers durable %s checkout over a later conversation binding',
  async channel => {
    const codebase = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [codebase, codebase, root]
    );
    const createEnv = () =>
      sql.create({
        codebase_id: codebase,
        workflow_type: 'task',
        workflow_id: randomUUID(),
        working_path: join(root, randomUUID()),
        branch_name: toBranchName(randomUUID()),
      });
    const a = await createEnv();
    const b = await createEnv();
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id) VALUES ($1, 'cli', $2, $3)`,
      [conversationId, conversationId, a.id]
    );
    const run = await sqlStore.createWorkflowRun({
      workflow_name: 'original',
      user_message: '',
      codebase_id: codebase,
      working_path: channel === 'path' ? a.working_path : undefined,
      metadata:
        channel === 'metadata'
          ? { isolation_env_id: a.id }
          : channel === 'owned'
            ? { owned_worktree: { envId: a.id } }
            : {},
      origin: { conversationId },
    });
    await sqlStore.failWorkflowRun(run.id, 'original');
    await updateConversation(conversationId, { isolation_env_id: b.id });
    await sql.withWorktreeRegistration(b, async mark => mark());
    await expect(sqlStore.resumeWorkflowRun(run.id)).resolves.toBeDefined();
  }
);

test.each(
  (['creation', 'late-binding', 'historical'] as const).flatMap(association =>
    [false, true].map(rebind => ({ association, rebind }))
  )
)(
  'SQL preserves a $association conversation checkout after retirement, rebind=$rebind, and detachment',
  async ({ association, rebind }) => {
    const codebase = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [codebase, codebase, root]
    );
    const env = await sql.create({
      codebase_id: codebase,
      workflow_type: 'task',
      workflow_id: randomUUID(),
      working_path: join(root, randomUUID()),
      branch_name: toBranchName(randomUUID()),
    });
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id) VALUES ($1, 'cli', $2, $3)`,
      [conversationId, conversationId, association === 'late-binding' ? null : env.id]
    );
    const run = await sqlStore.createWorkflowRun({
      workflow_name: 'conversation-owner',
      user_message: '',
      origin: { conversationId },
    });
    if (association === 'late-binding')
      await updateConversation(conversationId, { isolation_env_id: env.id });
    expect((await sqlStore.getWorkflowRun(run.id))?.metadata.isolation_env_id).toBe(env.id);
    if (association === 'historical')
      await db.query('UPDATE remote_agent_workflow_runs SET metadata = $2 WHERE id = $1', [
        run.id,
        '{}',
      ]);
    await sqlStore.failWorkflowRun(run.id, 'original failure');
    if (rebind) {
      const other = await sql.create({
        codebase_id: codebase,
        workflow_type: 'task',
        workflow_id: randomUUID(),
        working_path: join(root, randomUUID()),
        branch_name: toBranchName(randomUUID()),
      });
      await updateConversation(conversationId, { isolation_env_id: other.id });
      await sql.withWorktreeRegistration(other, async mark => mark());
      await updateConversation(conversationId, { isolation_env_id: null });
    }
    await sql.withWorktreeRegistration(env, async mark => mark(), {
      runOwnership: { releaseFailed: { kind: 'settled' } },
    });
    if (!rebind) await clearConversationCheckout(conversationId, env.id);
    const before = await sqlStore.getWorkflowRun(run.id);
    const events = await sqlStore.listWorkflowEvents(run.id);
    await expect(sqlStore.resumeWorkflowRun(run.id)).rejects.toThrow(
      `Checkout '${env.working_path}' was released; start a fresh run.`
    );
    expect(await sqlStore.getWorkflowRun(run.id)).toEqual(before);
    expect(await sqlStore.listWorkflowEvents(run.id)).toEqual(events);
  }
);

for (const field of ['isolation_env_id', 'owned_worktree'] as const) {
  test(`SQL malformed legacy ${field} keeps its conversation owner`, async () => {
    const codebase = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [codebase, codebase, root]
    );
    const env = await sql.create({
      codebase_id: codebase,
      workflow_type: 'task',
      workflow_id: randomUUID(),
      working_path: join(root, randomUUID()),
      branch_name: toBranchName(randomUUID()),
    });
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id) VALUES ($1, 'cli', $2, $3)`,
      [conversationId, conversationId, env.id]
    );
    const run = await sqlStore.createWorkflowRun({
      workflow_name: 'legacy',
      user_message: '',
      origin: { conversationId },
    });
    await sqlStore.claimPendingWorkflowRun(run.id);
    const metadata =
      field === 'isolation_env_id' ? { isolation_env_id: 42 } : { owned_worktree: { envId: 42 } };
    await db.query('UPDATE remote_agent_workflow_runs SET metadata = $2 WHERE id = $1', [
      run.id,
      JSON.stringify(metadata),
    ]);
    expect((await sql.getLiveRunOwningEnv(env.id))?.id).toBe(run.id);
    await expect(sql.withWorktreeRegistration(env, async mark => mark())).rejects.toBeInstanceOf(
      WorktreeInUseError
    );
  });

  for (const route of ['updateWorkflowRun', 'updateWorkflowRunMetadataIfRunning'] as const) {
    test(`SQL ${route} rejects malformed ${field}`, async () => {
      const run = await sqlStore.createWorkflowRun({ workflow_name: 'writer', user_message: '' });
      await sqlStore.claimPendingWorkflowRun(run.id);
      const before = await sqlStore.getWorkflowRun(run.id);
      const metadata =
        field === 'isolation_env_id' ? { isolation_env_id: 42 } : { owned_worktree: { envId: 42 } };
      await expect(
        route === 'updateWorkflowRun'
          ? sqlStore.updateWorkflowRun(run.id, { metadata })
          : sqlStore.updateWorkflowRunMetadataIfRunning(run.id, metadata)
      ).rejects.toThrow();
      expect(await sqlStore.getWorkflowRun(run.id)).toEqual(before);
    });
  }
}

test.each(
  (['pending', 'running', 'paused', 'failed'] as const).flatMap(status =>
    [false, true].map(rebindFirst => ({ status, rebindFirst }))
  )
)(
  'SQL setup selection releases provisional checkout: $status, rebindFirst=$rebindFirst',
  async ({ status, rebindFirst }) => {
    const codebase = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [codebase, codebase, root]
    );
    const createEnv = () =>
      sql.create({
        codebase_id: codebase,
        workflow_type: 'task',
        workflow_id: randomUUID(),
        working_path: join(root, randomUUID()),
        branch_name: toBranchName(randomUUID()),
      });
    const a = await createEnv();
    const b = await createEnv();
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id) VALUES ($1, 'cli', $2, $3)`,
      [conversationId, conversationId, a.id]
    );
    const run = await sqlStore.createWorkflowRun({
      workflow_name: 'setup',
      user_message: '',
      codebase_id: codebase,
      origin: { conversationId },
    });
    if (rebindFirst) await updateConversation(conversationId, { isolation_env_id: b.id });
    const { recordSetupRunCheckout } = await import('../workflows/worktree-setup');
    await recordSetupRunCheckout({ store: sqlStore }, run, b.working_path);
    if (!rebindFirst) await updateConversation(conversationId, { isolation_env_id: b.id });
    expect((await sqlStore.getWorkflowRun(run.id))?.metadata.isolation_env_id ?? null).toBeNull();
    if (status !== 'pending') await sqlStore.claimPendingWorkflowRun(run.id);
    if (status === 'paused') await sqlStore.updateWorkflowRun(run.id, { status });
    if (status === 'failed') await sqlStore.failWorkflowRun(run.id, 'original');
    await sql.withWorktreeRegistration(a, async mark => mark());
    await expect(sql.withWorktreeRegistration(b, async mark => mark())).rejects.toBeInstanceOf(
      WorktreeInUseError
    );
    if (status === 'failed' || status === 'paused')
      await expect(sqlStore.resumeWorkflowRun(run.id)).resolves.toBeDefined();
  }
);

for (const field of ['isolation_env_id', 'owned_worktree'] as const) {
  test(`SQL ${field} ownership conforms to the typed checkout reader`, async () => {
    const codebase = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [codebase, codebase, root]
    );
    const createEnv = () =>
      sql.create({
        codebase_id: codebase,
        workflow_type: 'task',
        workflow_id: randomUUID(),
        working_path: join(root, randomUUID()),
        branch_name: toBranchName(randomUUID()),
      });
    const conversationEnv = await createEnv();
    const referencedEnv = await createEnv();
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id) VALUES ($1, 'cli', $2, $3)`,
      [conversationId, conversationId, conversationEnv.id]
    );
    const run = await sqlStore.createWorkflowRun({
      workflow_name: 'conformance',
      user_message: '',
      codebase_id: codebase,
      origin: { conversationId },
    });
    const values: unknown[] = [
      undefined,
      null,
      '',
      referencedEnv.id,
      'unregistered',
      42,
      false,
      [],
      {},
      { envId: referencedEnv.id },
    ];
    const cases: Record<string, unknown>[] = values.flatMap(value =>
      value === undefined
        ? [{}]
        : field === 'owned_worktree'
          ? [{ [field]: { envId: value } }, { [field]: value }]
          : [{ [field]: value }]
    );
    for (const metadata of cases) {
      const references = checkoutEnvironmentReferences(metadata).filter(
        id => typeof id === 'string'
      );
      await db.query('UPDATE remote_agent_workflow_runs SET metadata = $2 WHERE id = $1', [
        run.id,
        JSON.stringify(metadata),
      ]);
      expect((await sql.getLiveRunOwningEnv(referencedEnv.id))?.id, JSON.stringify(metadata)).toBe(
        references.includes(referencedEnv.id) ? run.id : undefined
      );
      expect(
        (await sql.getLiveRunOwningEnv(conversationEnv.id))?.id,
        JSON.stringify(metadata)
      ).toBe(references.length === 0 ? run.id : undefined);
    }
  });
}

test.each([false, true])(
  'real setup binds only a registered checkout (failure: %s)',
  async fail => {
    const repo = await mkdtemp(join(root, 'setup-repo-'));
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: repo });
    await git('init', '--initial-branch=main');
    await git('remote', 'add', 'origin', repo);
    await git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial'
    );
    const codebase = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [codebase, codebase, repo]
    );
    const branch = 'setup-target';
    const selectedPath = join(repo, '.worktrees', branch);
    if (!fail) {
      const retired = await sql.create({
        codebase_id: codebase,
        workflow_type: 'task',
        workflow_id: randomUUID(),
        working_path: selectedPath,
        branch_name: toBranchName(branch),
      });
      await sql.withWorktreeRegistration(retired, async mark => mark());
    }
    const run = await sqlStore.createWorkflowRun({
      workflow_name: 'setup',
      user_message: '',
      codebase_id: codebase,
    });
    const { createRunWorktreeSetupExecutor, recordSetupRunCheckout } = await import(
      '../workflows/worktree-setup'
    );
    const executor = createRunWorktreeSetupExecutor({ store: sqlStore }, run, {});
    const provider = new WorktreeProvider(async () => ({
      path: '.worktrees',
      postCreate: [fail ? 'exit 7' : 'true'],
    }));
    const creation = provider.create(
      {
        codebaseId: codebase,
        codebaseName: codebase,
        canonicalRepoPath: toRepoPath(repo),
        workflowType: 'task',
        identifier: run.id,
        taskBranch: { kind: 'new', branch: toBranchName(branch), fromBranch: toBranchName('main') },
        baseBranch: toBranchName('main'),
      },
      executor
    );
    if (fail) {
      await expect(creation).rejects.toThrow('exit code 7');
      await expect(access(selectedPath)).rejects.toThrow();
      await sqlStore.failWorkflowRun(run.id, 'setup failed', { exitReason: 'launch_failed' });
      expect((await sqlStore.getWorkflowRun(run.id))?.working_path).toBeNull();
      await sqlStore.resumeWorkflowRun(run.id);
      expect((await sqlStore.getWorkflowRun(run.id))?.working_path).toBeNull();
      expect(
        (await sqlStore.listWorkflowEvents(run.id)).some(
          event => event.event_type === 'worktree_setup_failed'
        )
      ).toBe(true);
    } else {
      const environment = await creation;
      const registered = await registerWorktree(
        { store: sql.createIsolationStore(), provider, registrationsBeforeCreation: [] },
        environment,
        toRepoPath(repo),
        { codebase_id: codebase, workflow_type: 'task', workflow_id: run.id }
      );
      await recordSetupRunCheckout({ store: sqlStore }, run, registered.working_path);
      await expect(sqlStore.claimPendingWorkflowRun(run.id)).resolves.toBeDefined();
      expect((await sqlStore.getWorkflowRun(run.id))?.working_path).toBe(selectedPath);
    }
  }
);
