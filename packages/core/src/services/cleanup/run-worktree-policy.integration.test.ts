// @archon-test-isolated
import { beforeEach, afterEach, afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { setLogLevel } from '@archon/paths';
import { setPlatformPolicies } from '../../platforms/registry';
import { toBranchName } from '@archon/git';
import { configureIsolation, getIsolationProvider } from '@archon/isolation';
import type { IsolationEnvironmentRow, IIsolationStore } from '@archon/isolation';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

setLogLevel('silent');
const { SqliteAdapter, sqliteDialect } = await import('../../db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');
mock.module('../../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const isolationDb = await import('../../db/isolation-environments');
const { claimPendingWorkflowRun } = await import('../../db/workflows');
const { reclaimRunWorktree } = await import('./run-worktree');
let root: string;
let repo: string;
let codebaseId: string;
let env: IsolationEnvironmentRow;
let run: WorkflowRun;
let store: IIsolationStore;
let destroy: ReturnType<typeof spyOn<ReturnType<typeof getIsolationProvider>, 'destroy'>>;
const status = async () => (await isolationDb.getById(env.id))?.status;
/** Insert a run that uses `path`, as a run reusing the checkout would. */
async function seedRunAt(path: string | null, status: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'cli', $1)`,
    [id]
  );
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status, metadata, codebase_id, working_path)
     VALUES ($1, $1, 'test-wf', 'test', $2, '{}', $3, $4)`,
    [id, status, codebaseId, path]
  );
  return id;
}

beforeEach(async () => {
  setPlatformPolicies([]);
  root = await mkdtemp(join(tmpdir(), 'archon-release-policy-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  const workingPath = join(root, 'checkout');
  await mkdir(workingPath);
  codebaseId = randomUUID();
  const creationId = randomUUID();
  await db.query(
    "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, 'test/repo', $2)",
    [codebaseId, repo]
  );
  env = await isolationDb.create({
    codebase_id: codebaseId,
    workflow_type: 'task',
    workflow_id: 'release',
    working_path: workingPath,
    branch_name: toBranchName('fixture'),
    metadata: { worktree_creation_id: creationId },
  });
  run = {
    id: 'run',
    workflow_name: 'test',
    conversation_id: 'conv',
    parent_conversation_id: null,
    codebase_id: codebaseId,
    status: 'cancelled',
    outcome: null,
    user_message: '',
    metadata: { owned_worktree: { envId: env.id, creationId } },
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: env.working_path,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    origin: null,
  };
  store = isolationDb.createIsolationStore();
  configureIsolation(async () => ({
    baseBranch: toBranchName('main'),
    remote: 'upstream',
    path: '.worktrees',
  }));
  destroy = spyOn(getIsolationProvider(), 'destroy').mockImplementation(async (path, options) => {
    if (options && 'guardedRemoval' in options) await options.guardedRemoval?.beforeRemove();
    await removeTempTree(path);
    return {
      worktreeRemoved: true,
      directoryClean: true,
      branchDeleted: null,
      remoteBranchDeleted: null,
      warnings: [],
    };
  });
});

afterEach(async () => {
  destroy?.mockRestore();
  if (root) await removeTempTree(root);
});
afterAll(async () => {
  await db.close();
});

describe('owned worktree release policy', () => {
  test('keeps an owned worktree whose originating platform is no longer registered', async () => {
    await db.query(
      "UPDATE remote_agent_isolation_environments SET created_by_platform = 'removed-chat' WHERE id = $1",
      [env.id]
    );
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow(
      "platform 'removed-chat' is not registered"
    );
    expect(existsSync(env.working_path)).toBe(true);
    expect(await status()).toBe('active');
  });

  test('a detached adoption that claimed first is seen by the claimant check', async () => {
    const adopter = await seedRunAt(null, 'pending');
    expect((await claimPendingWorkflowRun(adopter, env.working_path))?.working_path).toBe(
      env.working_path
    );
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow(`claimable run ${adopter}`);
    expect(existsSync(env.working_path)).toBe(true);
    expect(await status()).toBe('active');
  });

  test('legacy and adopted runs retain checkout without manufacturing proof', async () => {
    run.metadata = {};
    expect(await reclaimRunWorktree(run, store)).toEqual({
      warnings: [expect.stringContaining('no valid proof')],
    });
    expect(existsSync(env.working_path)).toBe(true);
  });

  test('a record write failure before removal keeps the checkout', async () => {
    const real = store;
    store = {
      ...store,
      withWorktreeRegistration: (observed, remove) =>
        real.withWorktreeRegistration(observed, () =>
          remove(async () => {
            throw new Error('record write failed');
          })
        ),
    };
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow('record write failed');
    expect(existsSync(env.working_path)).toBe(true);
    expect(await status()).toBe('active');
  });

  test.each(['worktreeRemoved', 'directoryClean'] as const)(
    'incomplete provider %s result keeps the record active',
    async field => {
      const incomplete = spyOn(getIsolationProvider(), 'destroy').mockImplementation(
        async (_, options) => {
          if (options && 'guardedRemoval' in options) await options.guardedRemoval?.beforeRemove();
          return {
            worktreeRemoved: true,
            directoryClean: true,
            branchDeleted: null,
            remoteBranchDeleted: null,
            warnings: [],
            [field]: false,
          };
        }
      );
      try {
        await expect(reclaimRunWorktree(run, store)).rejects.toThrow(
          'filesystem removal incomplete'
        );
        expect(await status()).toBe('active');
      } finally {
        incomplete.mockRestore();
      }
    }
  );

  test.each(['record', 'path'])('mismatched %s refuses replacement estate', async kind => {
    if (kind === 'record') await isolationDb.updateMetadata(env.id, { worktree_creation_id: 'x' });
    if (kind === 'path') run.working_path = repo;

    await expect(reclaimRunWorktree(run, store)).rejects.toThrow('proof');
    expect(existsSync(env.working_path)).toBe(true);
    expect(await status()).toBe('active');
  });
});
