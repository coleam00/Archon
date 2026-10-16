// @archon-test-isolated
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toBranchName, toRepoPath } from '@archon/git';
import {
  configureIsolation,
  getIsolationProvider,
  IsolationResolver,
  recordWorktreeAdoption,
} from '@archon/isolation';
import { getLogLevel, setLogLevel, setLogSink } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { SqliteAdapter, sqliteDialect } from '../db/adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const isolation = await import('../db/isolation-environments');
const { createRegisteredWorktree } = await import('./registered-worktree');
const { resolveRegisteredWorktree, adoptRegisteredWorktree } =
  await import('../operations/workflow-adoption');
const { createCodebaseChildResolver } = await import('./child-isolation-resolver');
const originalEnv = {
  ARCHON_HOME: process.env.ARCHON_HOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
};
const originalLevel = getLogLevel();
const events: Record<string, unknown>[] = [];
let root: string;
let repo: string;
let codebaseId: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  root = track(await realpath(await mkdtemp(join(tmpdir(), 'archon-adoption-'))));
  process.env.ARCHON_HOME = join(root, 'home');
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
  setLogLevel('info');
  setLogSink(line => events.push(JSON.parse(line)));
  repo = join(root, 'repo');
  await mkdir(repo);
  git('init', '-q', '-b', 'dev');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '-qm', 'seed');
  const remote = join(root, 'remote.git');
  git('init', '--bare', '-q', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'dev');
  await mkdir(join(repo, '.archon'));
  await writeFile(
    join(repo, '.archon/config.yaml'),
    'worktree:\n  path: .worktrees\n  baseBranch: dev\n'
  );
  configureIsolation(async () => ({ path: '.worktrees', baseBranch: toBranchName('dev') }));
  codebaseId = randomUUID();
  await db.query('INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)', [
    codebaseId,
    'test/repo',
    repo,
  ]);
  events.length = 0;
});

afterEach(() => {
  setLogSink(undefined);
  setLogLevel(originalLevel);
  configureIsolation(async () => null);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const track = trackTempRoots();
afterAll(async () => {
  await db.close();
});

function expectAdoptionWarning(branchName: string, worktreePath: string, identifier: string): void {
  expect(events.filter(event => event.msg === 'worktree_adopted')).toEqual([
    expect.objectContaining({
      level: 40,
      branchName,
      worktreePath,
      codebaseId,
      workflowType: 'task',
      identifier,
    }),
  ]);
}

test('non-child reuse warns once and persists adoption over caller metadata', async () => {
  const input = {
    request: {
      workflowType: 'task' as const,
      identifier: 'reuse',
      codebaseId,
      codebaseName: 'test/repo',
      canonicalRepoPath: toRepoPath(repo),
    },
    createdByPlatform: 'cli',
    metadata: { adopted: true },
  };
  const first = await createRegisteredWorktree(isolation, input);
  const firstMetadata = (await isolation.getById(first.envId))?.metadata;
  expect(first.ownedWorktree).toBeDefined();
  expect(events.filter(event => event.msg === 'worktree_adopted')).toHaveLength(0);
  events.length = 0;
  const reused = await createRegisteredWorktree(isolation, {
    ...input,
    metadata: { adopted: false },
  });
  expect(reused.env.workingPath).toBe(first.env.workingPath);
  expect(reused.envId).toBe(first.envId);
  expect(reused.ownedWorktree).toBeUndefined();
  expectAdoptionWarning(reused.env.branchName, reused.env.workingPath, 'reuse');
  expect((await isolation.getById(reused.envId))?.metadata).toMatchObject({
    adopted: true,
    worktree_creation_id: null,
    worktree_branch_created: false,
  });
  expect(await isolation.countActiveByCodebase(codebaseId)).toBe(1);
  expect(firstMetadata).toMatchObject({
    adopted: false,
    worktree_creation_id: first.ownedWorktree?.creationId,
    worktree_branch_created: true,
  });
});

test('child reuse has one registration and one provider adoption warning', async () => {
  const store = isolation.createIsolationStore();
  const create = mock(store.create);
  const resolver = createCodebaseChildResolver(
    { ...store, create },
    { id: codebaseId, name: 'test/repo', default_cwd: repo, kind: 'repo' },
    { baseBranch: 'dev', createdByPlatform: 'cli', createdByUserId: undefined },
    { store: { getCodebase: async () => null, persistWorkflowEvent: async () => {} } }
  );
  if (!resolver) throw new Error('Expected repo resolver');
  const parentRun: WorkflowRun = {
    id: randomUUID(),
    workflow_name: 'test',
    conversation_id: 'conversation',
    parent_conversation_id: null,
    codebase_id: codebaseId,
    status: 'running',
    outcome: null,
    user_message: '',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: repo,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    origin: null,
  };
  const request = { parentRun, nodeId: 'build', childIndex: 2, codebaseId, setupEnvironment: {} };
  const first = await resolver.resolve(request);
  expect(create).toHaveBeenCalledTimes(1);
  create.mockClear();
  events.length = 0;
  const reused = await resolver.resolve(request);
  expect(create).toHaveBeenCalledTimes(1);
  expect(reused.cwd).toBe(first.cwd);
  expect(reused.envId).toBe(first.envId);
  expect(reused.ownedWorktree).toBeUndefined();
  const row = await isolation.getById(reused.envId);
  expect(row?.metadata).toMatchObject({
    adopted: true,
    worktree_creation_id: null,
    parent_run_id: parentRun.id,
    child_index: 2,
  });
  expect(await isolation.countActiveByCodebase(codebaseId)).toBe(1);
  expectAdoptionWarning(reused.branchName, reused.cwd, create.mock.calls[0][0].workflow_id);
  expect(events.filter(event => event.msg === 'workflow.child_worktree_adopted')).toHaveLength(0);
});

for (const reuse of ['existing', 'workflow', 'linked'] as const) {
  test(`registered resolver ${reuse} reuse warns and persists adoption`, async () => {
    const resolver = new IsolationResolver({
      store: isolation.createIsolationStore(),
      provider: getIsolationProvider(),
    });
    const request = {
      existingEnvId: null,
      codebase: { id: codebaseId, name: 'test/repo', defaultCwd: repo },
      hints: { workflowType: 'issue' as const, workflowId: '42' },
      platformType: 'cli',
    };
    const first = await resolver.resolve(request);
    if (first.status !== 'resolved') throw new Error('Expected creation');
    const originalRow = await isolation.getById(first.env.id);
    events.length = 0;
    const reused = await resolver.resolve({
      ...request,
      ...(reuse === 'existing' ? { existingEnvId: first.env.id } : {}),
      ...(reuse === 'linked'
        ? { hints: { workflowType: 'pr', workflowId: '99', linkedIssues: [42] } }
        : {}),
    });
    if (reused.status !== 'resolved') throw new Error('Expected reuse');
    const row = await isolation.getById(first.env.id);
    expect({
      cwd: reused.cwd,
      adopted: row?.metadata.adopted,
      warnings: events.filter(e => e.msg === 'worktree_adopted' && e.level === 40).length,
    }).toEqual({ cwd: first.cwd, adopted: true, warnings: 1 });
    expect(reused.env.metadata.adopted).toBe(true);
    expect(row?.created_at).toEqual(originalRow?.created_at);
    expect(row?.metadata.worktree_creation_id).toBe(originalRow?.metadata.worktree_creation_id);
    expect(await isolation.countActiveByCodebase(codebaseId)).toBe(1);
    events.length = 0;
    await resolver.resolve({ ...request, existingEnvId: first.env.id });
    expect(events.filter(e => e.msg === 'worktree_adopted' && e.level === 40)).toHaveLength(1);
  });
}

for (const reuse of ['existing', 'workflow', 'linked'] as const) {
  test(`registered resolver ${reuse} refuses a foreign clone without recording adoption`, async () => {
    const resolver = new IsolationResolver({
      store: isolation.createIsolationStore(),
      provider: getIsolationProvider(),
    });
    const request = {
      existingEnvId: null,
      codebase: { id: codebaseId, name: 'test/repo', defaultCwd: repo },
      hints: { workflowType: 'issue' as const, workflowId: '42' },
      platformType: 'cli',
    };
    const first = await resolver.resolve(request);
    if (first.status !== 'resolved') throw new Error('Expected creation');
    const original = await isolation.getById(first.env.id);
    const otherClone = join(root, 'other-clone');
    git('clone', '-q', repo, otherClone);
    events.length = 0;
    await expect(
      resolver.resolve({
        ...request,
        codebase: { ...request.codebase, defaultCwd: otherClone },
        ...(reuse === 'existing' ? { existingEnvId: first.env.id } : {}),
        ...(reuse === 'linked'
          ? { hints: { workflowType: 'pr', workflowId: '99', linkedIssues: [42] } }
          : {}),
      })
    ).rejects.toThrow('belongs to a different clone');
    expect(await isolation.getById(first.env.id)).toEqual(original);
    expect(events.filter(e => e.msg === 'worktree_adopted')).toHaveLength(0);
  });
}

for (const replacementPath of ['same', 'different'] as const) {
  test(`adoption refuses a ${replacementPath}-path replacement between verification and write`, async () => {
    git('worktree', 'add', '-qb', 'race', join(root, 'race'));
    const input = {
      codebase_id: codebaseId,
      workflow_type: 'task' as const,
      workflow_id: 'race',
      working_path: join(root, 'race'),
      branch_name: toBranchName('race'),
    };
    const observed = await isolation.create(input);
    const store = isolation.createIsolationStore();
    let replacement = observed;
    const racingStore = {
      updateMetadata: async (...args: Parameters<typeof store.updateMetadata>) => {
        replacement = await isolation.create({
          ...input,
          working_path: replacementPath === 'same' ? input.working_path : join(root, 'replacement'),
        });
        await store.updateMetadata(...args);
      },
    };
    events.length = 0;
    await expect(recordWorktreeAdoption(racingStore, observed, repo)).rejects.toThrow(
      'changed during adoption'
    );
    expect(await isolation.getById(observed.id)).toEqual(replacement);
    expect(events.filter(event => event.msg === 'worktree_adopted')).toHaveLength(0);
    await store.updateMetadata(replacement.id, { adopted: true }, replacement);
    expect((await store.getById(replacement.id))?.metadata.adopted).toBe(true);
  });
}

for (const changed of ['working_path', 'branch_name', 'created_at', 'metadata'] as const) {
  test(`legacy tokenless adoption refuses a concurrent ${changed} replacement`, async () => {
    git('worktree', 'add', '-qb', 'legacy', join(root, 'legacy'));
    const created = await isolation.create({
      codebase_id: codebaseId,
      workflow_type: 'task',
      workflow_id: 'legacy',
      working_path: join(root, 'legacy'),
      branch_name: toBranchName('legacy'),
    });
    await db.query('UPDATE remote_agent_isolation_environments SET metadata = $1 WHERE id = $2', [
      '{}',
      created.id,
    ]);
    const observed = (await isolation.getById(created.id))!;
    const values = {
      working_path: join(root, 'other'),
      branch_name: 'other',
      created_at: '2000-01-01 00:00:00',
      metadata: '{"legacy":true}',
    };
    const racingStore = {
      updateMetadata: async (...args: Parameters<typeof isolation.updateMetadata>) => {
        await db.query(
          `UPDATE remote_agent_isolation_environments SET ${changed} = $1 WHERE id = $2`,
          [values[changed], created.id]
        );
        await isolation.updateMetadata(...args);
      },
    };
    events.length = 0;
    await expect(recordWorktreeAdoption(racingStore, observed, repo)).rejects.toThrow(
      'changed during adoption'
    );
    const replacement = (await isolation.getById(created.id))!;
    expect(replacement.metadata.adopted).toBeUndefined();
    expect(events.filter(event => event.msg === 'worktree_adopted')).toHaveLength(0);
    await isolation.updateMetadata(replacement.id, { adopted: true }, replacement);
    expect((await isolation.getById(replacement.id))?.metadata.adopted).toBe(true);
  });
}

test('unchanged legacy registration remains adoptable after an integer-like metadata key is merged', async () => {
  git('worktree', 'add', '-qb', 'legacy-merge', join(root, 'legacy-merge'));
  const created = await isolation.create({
    codebase_id: codebaseId,
    workflow_type: 'task',
    workflow_id: 'legacy-merge',
    working_path: join(root, 'legacy-merge'),
    branch_name: toBranchName('legacy-merge'),
  });
  await db.query('UPDATE remote_agent_isolation_environments SET metadata = $1 WHERE id = $2', [
    '{"label":"legacy"}',
    created.id,
  ]);
  await isolation.updateMetadata(created.id, { '1': 'step result' });
  const observed = (await isolation.getById(created.id))!;
  events.length = 0;
  await recordWorktreeAdoption(isolation, observed, repo);
  expect((await isolation.getById(created.id))?.metadata).toEqual({
    label: 'legacy',
    '1': 'step result',
    adopted: true,
  });
  expectAdoptionWarning(observed.branch_name, observed.working_path, 'legacy-merge');
});

for (const handoff of ['resolve', 'adopt'] as const) {
  for (const branch of ['unchanged', 'switched', 'detached'] as const) {
    test(`${handoff} handoff validates a ${branch} branch after selection`, async () => {
      const path = join(root, 'handoff');
      git('worktree', 'add', '-qb', 'selected', path);
      const environment = await isolation.create({
        codebase_id: codebaseId,
        workflow_type: 'task',
        workflow_id: 'handoff',
        working_path: path,
        branch_name: toBranchName('selected'),
      });
      const lane = { kind: 'reuse-worktree' as const, environment };
      await resolveRegisteredWorktree(isolation, lane);
      if (branch === 'switched') git('-C', path, 'checkout', '-qb', 'other');
      if (branch === 'detached') git('-C', path, 'checkout', '-q', '--detach');
      events.length = 0;
      const result =
        handoff === 'resolve'
          ? resolveRegisteredWorktree(isolation, lane)
          : adoptRegisteredWorktree(isolation, lane, repo);
      if (branch === 'unchanged') {
        expect((await result).branch_name).toBe('selected');
        expect((await isolation.getById(environment.id))?.metadata.adopted).toBe(
          handoff === 'adopt' ? true : undefined
        );
      } else {
        await expect(result).rejects.toThrow('branch');
        expect(await isolation.getById(environment.id)).toEqual(environment);
        expect(events.filter(event => event.msg === 'worktree_adopted')).toHaveLength(0);
      }
    });
  }
}
