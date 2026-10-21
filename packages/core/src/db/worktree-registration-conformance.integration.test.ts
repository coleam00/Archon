// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeTempTree } from '@archon/paths/test-utils';
import { commit } from '@archon/workflows/file-store';
import { toBranchName } from '@archon/git';
import { sameWorktreeRegistration, type IsolationEnvironmentRow } from '@archon/isolation/types';
import type { IIsolationStore } from '@archon/isolation';
import { createFileWorkflowHost } from '../workflows/file-host';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';
import type { IDatabase } from './adapters/types';

const root = await mkdtemp(join(tmpdir(), 'registration-conformance-'));
const pgUrl = process.env.ARCHON_TEST_PG_URL;
const scratchName = `archon_registration_${randomUUID().replaceAll('-', '')}`;
let admin: import('pg').Pool | undefined;
let db: IDatabase;
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
  db = new SqliteAdapter(':memory:');
}
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => dialect,
  getDatabaseType: () => (pgUrl ? 'postgresql' : 'sqlite'),
}));
const sql = await import('./isolation-environments');
const prior = Object.fromEntries(
  ['ARCHON_HOME', 'DATABASE_URL', 'GITHUB_APP_ID'].map(key => [key, process.env[key]])
);
process.env.ARCHON_HOME = root;
process.env.DATABASE_URL = '';
process.env.GITHUB_APP_ID = '';
const fileRoot = join(root, 'store');
const file = (await createFileWorkflowHost(fileRoot)).records.isolation;
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

const codebase = randomUUID();
await db.query('INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)', [
  codebase,
  'conformance',
  root,
]);
const row: IsolationEnvironmentRow = {
  id: randomUUID(),
  codebase_id: codebase,
  workflow_type: 'task',
  workflow_id: 'original',
  provider: 'worktree',
  working_path: join(root, 'checkout'),
  branch_name: 'original',
  status: 'active',
  created_at: new Date('2026-01-01T00:00:00.123Z'),
  created_by_platform: null,
  created_by_user_id: null,
  metadata: { nested: { left: 1, right: [null, true, 'value'] } },
};

const replacementCodebase = randomUUID();
const replacementUser = randomUUID();
await db.query('INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)', [
  replacementCodebase,
  'replacement',
  root,
]);
await db.query('INSERT INTO remote_agent_users (id) VALUES ($1)', [replacementUser]);
// Exhaustive by row key: a new field must acquire a cross-store identity case.
const changedFields = {
  id: randomUUID(),
  codebase_id: replacementCodebase,
  workflow_type: 'issue',
  workflow_id: 'replacement',
  provider: 'container',
  working_path: join(root, 'replacement'),
  branch_name: 'replacement',
  status: 'destroyed',
  created_at: new Date('2026-01-01T00:00:00.124Z'),
  created_by_platform: 'cli',
  created_by_user_id: replacementUser,
  metadata: { nested: { left: 2, right: [null, true, 'value'] } },
} satisfies IsolationEnvironmentRow;

for (const token of [undefined, 'original', '', '1', 'true']) {
  const tokened = typeof token === 'string';
  const observed: IsolationEnvironmentRow = {
    ...row,
    metadata: { ...row.metadata, ...(tokened ? { worktree_registration_id: token } : {}) },
  };
  const cases: [string, IsolationEnvironmentRow][] = [
    ['unchanged', observed],
    [
      'metadata key order',
      {
        ...observed,
        metadata: { ...observed.metadata, nested: { right: [null, true, 'value'], left: 1 } },
      },
    ],
    [
      'registration token',
      { ...observed, metadata: { ...observed.metadata, worktree_registration_id: 'replacement' } },
    ],
    ['token removed', { ...observed, metadata: row.metadata }],
    ['numeric token', { ...observed, metadata: { ...row.metadata, worktree_registration_id: 1 } }],
    [
      'boolean token',
      { ...observed, metadata: { ...row.metadata, worktree_registration_id: true } },
    ],
    ['null token', { ...observed, metadata: { ...row.metadata, worktree_registration_id: null } }],
    ...Object.entries(changedFields).map(([key, value]): [string, IsolationEnvironmentRow] => [
      key,
      {
        ...observed,
        [key]:
          key === 'metadata'
            ? {
                ...changedFields.metadata,
                ...(tokened ? { worktree_registration_id: token } : {}),
              }
            : value,
      },
    ]),
  ];
  for (const [name, candidate] of cases) {
    for (const operation of ['claim', 'retire', 'status', 'metadata'] as const) {
      test(`${pgUrl ? 'postgres' : 'sqlite'}/file ${tokened ? `token ${JSON.stringify(token)}` : 'legacy'} ${operation}: ${name}`, async () => {
        const current: IsolationEnvironmentRow =
          operation === 'status' ? { ...candidate, status: 'destroyed' } : candidate;
        await db.query('DELETE FROM remote_agent_isolation_environments', []);
        await db.query(
          `INSERT INTO remote_agent_isolation_environments
           (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name,
            status, created_at, created_by_platform, created_by_user_id, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            current.id,
            current.codebase_id,
            current.workflow_type,
            current.workflow_id,
            current.provider,
            current.working_path,
            current.branch_name,
            current.status,
            current.created_at.toISOString(),
            current.created_by_platform,
            current.created_by_user_id,
            JSON.stringify(current.metadata),
          ]
        );
        await commit(fileRoot, [], async () => ({
          result: undefined,
          changes: { documents: { 'host/isolation.json': [current] } },
        }));
        const matches = sameWorktreeRegistration(current, observed);
        const accepts =
          matches &&
          (operation === 'retire' ||
            (operation === 'status'
              ? current.status === 'destroyed'
              : current.status === 'active'));
        const expected = tokened
          ? ![
              'id',
              'working_path',
              'registration token',
              'token removed',
              'null token',
              'numeric token',
              'boolean token',
              'provider',
            ].includes(name)
          : ['unchanged', 'metadata key order', 'token removed', 'status'].includes(name);
        expect(matches).toBe(expected);
        for (const store of [sql, file]) {
          await checkOperation(store, operation, observed, current, accepts, name);
        }
      });
    }
  }
}

type Operation = 'claim' | 'retire' | 'status' | 'metadata';

async function checkOperation(
  store: IIsolationStore,
  operation: Operation,
  observed: IsolationEnvironmentRow,
  current: IsolationEnvironmentRow,
  accepts: boolean,
  name: string
): Promise<void> {
  let called = false;
  const actions = {
    claim: () =>
      store.withWorktreeRegistration(observed, async mark => {
        called = true;
        await mark();
      }),
    retire: () => store.markWorktreeDestroyed(observed),
    status: () => store.updateStatus(observed.id, 'active', observed),
    metadata: () => store.updateMetadata(observed.id, { adopted: true }, observed),
  };
  const action = actions[operation]();
  if (accepts) await action;
  else if (name === 'id') await expect(action).rejects.toThrow();
  else
    await expect(action).rejects.toThrow(
      operation === 'metadata' ? 'changed during adoption' : 'changed during cleanup'
    );
  if (operation === 'claim') expect(called).toBe(accepts);
  const persisted = await store.getById(current.id);
  const resultingStatus = {
    claim: 'destroyed',
    retire: 'destroyed',
    status: 'active',
    metadata: current.status,
  } as const;
  expect(persisted?.status).toBe(accepts ? resultingStatus[operation] : current.status);
  expect(persisted?.metadata).toEqual(
    accepts && operation === 'metadata' ? { ...current.metadata, adopted: true } : current.metadata
  );
}

const sqlRuns = await import('./workflows');
const fileHost = await createFileWorkflowHost(fileRoot);
for (const [name, records, runs] of [
  ['sql', { isolation: sql.createIsolationStore(), attachWorktree: sql.attachWorktree }, sqlRuns],
  ['files', fileHost.records, fileHost.deps.store],
] as const) {
  async function unattached(envCodebaseId = codebase) {
    const env = await records.isolation.create({
      codebase_id: envCodebaseId,
      workflow_type: 'task',
      workflow_id: randomUUID(),
      working_path: join(root, randomUUID()),
      branch_name: toBranchName('item'),
    });
    const run = await runs.createWorkflowRun({
      codebase_id: codebase,
      workflow_name: 'attachment',
      user_message: '',
    });
    return { env, run };
  }

  test.each(['pending', 'running', 'paused', 'failed'] as const)(
    `${name}: attachment excludes removal while %s`,
    async status => {
      const { env, run } = await unattached();
      await records.attachWorktree(run.id, env);
      if (status === 'failed') await runs.failWorkflowRun(run.id, 'resumable');
      else if (status !== 'pending') await runs.updateWorkflowRun(run.id, { status });
      let removed = false;
      await expect(
        records.isolation.withWorktreeRegistration(env, async mark => {
          removed = true;
          await mark();
        })
      ).rejects.toThrow('claimable run');
      expect(removed).toBe(false);
      expect((await records.isolation.getById(env.id))?.status).toBe('active');
      expect((await runs.getWorkflowRun(run.id))?.working_path).toBe(env.working_path);
    }
  );

  test.each(['other-codebase', 'other-path', 'completed', 'cancelled'] as const)(
    `${name}: attachment preserves a run with %s state`,
    async state => {
      const { env, run } = await unattached(
        state === 'other-codebase' ? replacementCodebase : codebase
      );
      if (state === 'other-path')
        await runs.updateWorkflowRun(run.id, { working_path: join(root, 'other') });
      if (state === 'completed') {
        await runs.claimPendingWorkflowRun(run.id);
        await runs.completeWorkflowRun(run.id, { duration_ms: 0 });
      }
      if (state === 'cancelled') await runs.cancelWorkflowRun(run.id);
      const before = await runs.getWorkflowRun(run.id);
      await expect(records.attachWorktree(run.id, env)).rejects.toThrow('Cannot attach checkout');
      expect(await runs.getWorkflowRun(run.id)).toEqual(before);
    }
  );

  test(`${name}: removal excludes attachment to the selected registration`, async () => {
    const { env, run } = await unattached();
    let entered!: () => void;
    let finish!: () => void;
    const locked = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    const removal = records.isolation.withWorktreeRegistration(env, async mark => {
      entered();
      await gate;
      await mark();
    });
    await locked;
    const attachment = records.attachWorktree(run.id, env);
    void attachment.catch(() => undefined);
    const attachmentState = await Promise.race([
      attachment.then(
        () => 'attached',
        () => 'refused'
      ),
      Bun.sleep(20).then(() => 'locked'),
    ]);
    finish();
    await removal;
    expect(attachmentState).toBe('locked');
    await expect(attachment).rejects.toThrow('changed during cleanup');
    expect((await runs.getWorkflowRun(run.id))?.working_path).toBeNull();
  });

  test(`${name}: a replaced selected registration cannot attach`, async () => {
    const { env, run } = await unattached();
    await records.isolation.updateMetadata(env.id, { worktree_registration_id: randomUUID() });
    await expect(records.attachWorktree(run.id, env)).rejects.toThrow('changed during cleanup');
    expect((await runs.getWorkflowRun(run.id))?.working_path).toBeNull();
  });

  test(`${name}: claim wins before removal and pins the checkout`, async () => {
    const { env, run } = await unattached();
    expect(await runs.claimPendingWorkflowRun(run.id, env.working_path)).not.toBeNull();
    await expect(
      records.isolation.withWorktreeRegistration(env, async mark => mark())
    ).rejects.toThrow('claimable run');
  });

  test(`${name}: removal excludes a concurrent execution claim`, async () => {
    const { env, run } = await unattached();
    let entered!: () => void;
    let finish!: () => void;
    const locked = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    const removal = records.isolation.withWorktreeRegistration(env, async mark => {
      entered();
      await gate;
      await mark();
    });
    await locked;
    const claim = runs.claimPendingWorkflowRun(run.id, env.working_path);
    const claimState = await Promise.race([
      claim.then(() => 'claimed'),
      Bun.sleep(20).then(() => 'locked'),
    ]);
    finish();
    await removal;
    expect(claimState).toBe('locked');
    expect(await claim).toBeNull();
    expect((await runs.getWorkflowRun(run.id))?.status).toBe('pending');
  });

  test(`${name}: resume wins before settlement cleanup and pins the checkout`, async () => {
    const { env, run } = await unattached();
    await records.attachWorktree(run.id, env);
    await runs.failWorkflowRun(run.id, 'resumable');
    expect((await runs.resumeWorkflowRun(run.id)).status).toBe('running');
    await expect(
      records.isolation.withWorktreeRegistration(env, async mark => mark(), { kind: 'settled' })
    ).rejects.toThrow('claimable run');
  });

  test(`${name}: settlement cleanup wins and refuses a late failed resume`, async () => {
    const { env, run } = await unattached();
    await records.attachWorktree(run.id, env);
    await runs.failWorkflowRun(run.id, 'resumable');
    let entered!: () => void;
    let finish!: () => void;
    const locked = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    const removal = records.isolation.withWorktreeRegistration(
      env,
      async mark => {
        entered();
        await gate;
        await mark();
      },
      { kind: 'settled' }
    );
    await locked;
    const resume = runs.resumeWorkflowRun(run.id);
    void resume.catch(() => undefined);
    const resumeState = await Promise.race([
      resume.then(
        () => 'resumed',
        () => 'refused'
      ),
      Bun.sleep(20).then(() => 'locked'),
    ]);
    finish();
    await removal;
    expect(resumeState).toBe('locked');
    await expect(resume).rejects.toThrow('Worktree was released');
    expect((await runs.getWorkflowRun(run.id))?.status).toBe('failed');
  });
}
