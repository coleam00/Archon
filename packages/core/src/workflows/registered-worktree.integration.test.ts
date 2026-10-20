// @archon-test-isolated
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorktrees, toBranchName, toRepoPath, toWorktreePath } from '@archon/git';
import {
  configureIsolation,
  getIsolationProvider,
  IsolationResolver,
  recordWorktreeAdoption,
} from '@archon/isolation';
import { getLogLevel, setLogLevel, setLogSink } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
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
const { resolveRegisteredWorktree, adoptRegisteredWorktree } = await import(
  '../operations/workflow-adoption'
);
const { createCodebaseChildResolver } = await import('./child-isolation-resolver');
const originalEnv = {
  ARCHON_HOME: process.env.ARCHON_HOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_TRACE2_PERF: process.env.GIT_TRACE2_PERF,
};
const originalLevel = getLogLevel();
const events: Record<string, unknown>[] = [];
let root: string;
let repo: string;
let codebaseId: string;
let rollbackTrace: { label: string; path: string } | undefined;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'archon-adoption-')));
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

afterEach(async () => {
  setLogSink(undefined);
  setLogLevel(originalLevel);
  configureIsolation(async () => null);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    if (rollbackTrace) {
      const trace = rollbackTrace;
      rollbackTrace = undefined;
      console.error(`[rollback timing] ${trace.label} Git Trace2 perf begin`);
      try {
        console.error(await readFile(trace.path, 'utf8'));
      } catch (error) {
        console.error(`[rollback timing] ${trace.label} Trace2 read failed: ${String(error)}`);
      }
      console.error(`[rollback timing] ${trace.label} Git Trace2 perf end`);
    }
  } finally {
    await removeTempTree(root);
  }
});
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

test.each(['checkout', 'local branch', 'remote branch'])(
  'child reuse leaves the historical base unavailable after config changes: %s',
  async reuse => {
    const store = isolation.createIsolationStore();
    const create = mock(store.create);
    const surface = { baseBranch: 'dev', createdByPlatform: 'cli', createdByUserId: undefined };
    const resolver = createCodebaseChildResolver(
      { ...store, create },
      { id: codebaseId, name: 'test/repo', default_cwd: repo, kind: 'repo' },
      surface,
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
    surface.baseBranch = 'main';
    git('branch', 'main');
    git('push', '-q', 'origin', 'main');
    configureIsolation(async () => ({ path: '.worktrees', baseBranch: toBranchName('main') }));
    await writeFile(
      join(repo, '.archon/config.yaml'),
      'worktree:\n  path: .worktrees\n  baseBranch: main\n'
    );
    if (reuse !== 'checkout') {
      git('worktree', 'remove', first.cwd);
      if (reuse === 'remote branch') {
        git('push', '-q', 'origin', first.branchName);
        git('branch', '-D', first.branchName);
      }
    }
    const reused = await resolver.resolve(request);
    expect(create).toHaveBeenCalledTimes(1);
    expect(reused.cutFromCommit).toBeUndefined();
    expect(
      execFileSync('git', ['-C', reused.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    ).toBe(git('rev-parse', 'dev'));
    expect(first.baseBranch).toBe('dev');
    expect(reused.baseBranch).toBeUndefined();
    expect(reused.cwd).toBe(first.cwd);
    expect(reused.envId).toBe(first.envId);
    if (reuse === 'checkout') expect(reused.ownedWorktree).toBeUndefined();
    const row = await isolation.getById(reused.envId);
    expect(row?.metadata).toMatchObject({
      adopted: reuse === 'checkout',
      parent_run_id: parentRun.id,
      child_index: 2,
    });
    expect(await isolation.countActiveByCodebase(codebaseId)).toBe(1);
    if (reuse === 'checkout') {
      expect(row?.metadata.worktree_creation_id).toBeNull();
      expectAdoptionWarning(reused.branchName, reused.cwd, create.mock.calls[0][0].workflow_id);
    }
    expect(events.filter(event => event.msg === 'workflow.child_worktree_adopted')).toHaveLength(0);
  }
);

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
    worktree_registration_id: expect.any(String),
  });
  expectAdoptionWarning(observed.branch_name, observed.working_path, 'legacy-merge');
});

test('a worktree whose record cannot be written is removed and the insert error rethrown', async () => {
  const insertError = new Error('database is locked');
  const failing = {
    listActive: isolation.listActive,
    create: async (): Promise<never> => Promise.reject(insertError),
  };
  const input = {
    request: {
      workflowType: 'task' as const,
      identifier: 'unrecorded',
      codebaseId,
      codebaseName: 'test/repo',
      canonicalRepoPath: toRepoPath(repo),
    },
    createdByPlatform: 'cli',
  };

  await expect(createRegisteredWorktree(failing, input)).rejects.toBe(insertError);

  expect(git('worktree', 'list', '--porcelain')).not.toContain('unrecorded');
  expect(git('branch', '--list')).not.toContain('unrecorded');
  expect(await isolation.countActiveByCodebase(codebaseId)).toBe(0);
});

for (const persistence of ['sql', 'file'] as const) {
  for (const owner of ['same-codebase', 'other-codebase'] as const) {
    test(`${persistence}: unlink rollback preserves a ${owner} adoption and its work`, async () => {
      const store =
        persistence === 'sql'
          ? isolation.createIsolationStore()
          : (await (await import('./file-host')).createFileWorkflowHost(join(root, 'store')))
              .records.isolation;
      const resolver = new IsolationResolver({ store, provider: getIsolationProvider() });
      const created = await resolver.resolve({
        existingEnvId: null,
        codebase: { id: codebaseId, name: 'test/repo', defaultCwd: repo },
        hints: { workflowType: 'task', workflowId: 'unlink-adoption' },
        platformType: 'cli',
      });
      if (created.status !== 'resolved' || created.method.type !== 'created') {
        throw new Error('expected created checkout');
      }
      let adopted =
        owner === 'same-codebase'
          ? await recordWorktreeAdoption(store, created.env, repo)
          : created.env;
      if (owner === 'other-codebase') {
        const otherCodebaseId = randomUUID();
        await db.query(
          'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
          [otherCodebaseId, 'duplicate/repo', repo]
        );
        adopted = await store.create({
          ...created.env,
          codebase_id: otherCodebaseId,
          branch_name: toBranchName(created.env.branch_name),
          created_by_platform: 'cli',
          created_by_user_id: undefined,
        });
      }
      const work = join(adopted.working_path, 'in-progress.txt');
      await writeFile(work, 'keep this work');
      events.length = 0;
      await resolver.releaseUnlinked(created);
      expect(await store.getById(adopted.id)).toEqual(adopted);
      expect((await listWorktrees(toRepoPath(repo))).map(worktree => worktree.path)).toContain(
        toWorktreePath(adopted.working_path)
      );
      expect(await Bun.file(work).text()).toBe('keep this work');
      expect(events).toContainEqual(
        expect.objectContaining({ msg: 'isolation_rollback_skipped_registered' })
      );
    });
  }

  for (const staleKind of [
    'missing',
    'null',
    'old-proof',
    'other-missing',
    'other-null',
    'other-old-proof',
    'cross-codebase-missing',
    'cross-codebase-null',
    'cross-codebase-old-proof',
    'different',
  ] as const) {
    test(`${persistence}: an older ${staleKind} workflow row does not retain a newly created unregistered checkout`, async () => {
      const store =
        persistence === 'sql'
          ? isolation
          : (await (await import('./file-host')).createFileWorkflowHost(join(root, 'store')))
              .records.isolation;
      const staleCodebaseId = staleKind.startsWith('cross-codebase-') ? randomUUID() : codebaseId;
      if (staleCodebaseId !== codebaseId) {
        await db.query(
          'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
          [staleCodebaseId, 'duplicate/repo', repo]
        );
      }
      const stale = await store.create({
        codebase_id: staleCodebaseId,
        workflow_type: 'task',
        workflow_id: staleKind.startsWith('other-') ? 'other' : 'restart',
        working_path:
          staleKind !== 'different'
            ? join(repo, '.worktrees', 'archon', 'task-restart-new')
            : join(root, 'missing-checkout'),
        branch_name: toBranchName('old-branch'),
        metadata: staleKind.endsWith('missing')
          ? {}
          : { worktree_creation_id: staleKind.endsWith('old-proof') ? 'old-creation' : null },
      });
      const failure = new Error('registration rejected');
      await expect(
        createRegisteredWorktree(
          {
            listActive: store.listActive,
            create: async () => {
              throw failure;
            },
          },
          {
            request: {
              workflowType: 'task',
              identifier: 'restart-new',
              codebaseId,
              codebaseName: 'test/repo',
              canonicalRepoPath: toRepoPath(repo),
            },
            workflowId: 'restart',
            createdByPlatform: 'cli',
          }
        )
      ).rejects.toBe(failure);
      expect(git('worktree', 'list', '--porcelain')).not.toContain('restart-new');
      expect(git('branch', '--list')).not.toContain('restart-new');
      expect(await store.getById(stale.id)).toEqual(stale);
    });
  }

  test(`${persistence}: an older row from another codebase does not retain a resolver-created unregistered checkout`, async () => {
    const store =
      persistence === 'sql'
        ? isolation.createIsolationStore()
        : (await (await import('./file-host')).createFileWorkflowHost(join(root, 'store'))).records
            .isolation;
    const staleCodebaseId = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [staleCodebaseId, 'duplicate/repo', repo]
    );
    const stale = await store.create({
      codebase_id: staleCodebaseId,
      workflow_type: 'task',
      workflow_id: 'restart',
      working_path: join(repo, '.worktrees', 'archon', 'task-restart'),
      branch_name: toBranchName('old-branch'),
      metadata: {},
    });
    const failure = new Error('registration rejected');
    const resolver = new IsolationResolver({
      store: {
        ...store,
        create: async () => {
          throw failure;
        },
      },
      provider: getIsolationProvider(),
    });
    await expect(
      resolver.resolve({
        existingEnvId: null,
        codebase: { id: codebaseId, name: 'test/repo', defaultCwd: repo },
        hints: { workflowType: 'task', workflowId: 'restart' },
        platformType: 'cli',
      })
    ).rejects.toBe(failure);
    expect(git('worktree', 'list', '--porcelain')).not.toContain('task-restart');
    expect(git('branch', '--list')).not.toContain('task-restart');
    expect(await store.getById(stale.id)).toEqual(stale);
  });

  for (const adopter of [
    'same-workflow',
    'other-workflow',
    'other-codebase',
    'replaced-stale',
  ] as const) {
    test(`${persistence}: rollback preserves a concurrent ${adopter} adoption before the final lookup`, async () => {
      const label = `${persistence}/${adopter}`;
      const startedAt = performance.now();
      async function phase<T>(name: string, run: () => Promise<T>): Promise<T> {
        const phaseStart = performance.now();
        const log = (event: string) =>
          console.error(
            '[rollback timing]',
            JSON.stringify({
              label,
              phase: name,
              event,
              time: new Date().toISOString(),
              elapsedMs: performance.now() - startedAt,
              phaseMs: performance.now() - phaseStart,
            })
          );
        log('start');
        try {
          const result = await run();
          log('done');
          return result;
        } catch (error) {
          log('error');
          throw error;
        }
      }
      // Trace2 keeps Git's internal waits and child-process timings even when exec captures stderr.
      const tracePath = join(root, 'rollback-git.perf');
      await writeFile(tracePath, '');
      rollbackTrace = { label, path: tracePath };
      process.env.GIT_TRACE2_PERF = tracePath;
      const store = await phase('open store', async () =>
        persistence === 'sql'
          ? isolation
          : (await (await import('./file-host')).createFileWorkflowHost(join(root, 'store')))
              .records.isolation
      );
      if (adopter === 'replaced-stale') {
        await phase('seed stale row', () =>
          store.create({
            codebase_id: codebaseId,
            workflow_type: 'task',
            workflow_id: 'concurrent',
            working_path: join(repo, '.worktrees', 'archon', 'task-concurrent'),
            branch_name: toBranchName('archon/task-concurrent'),
            metadata: { worktree_creation_id: 'old-creation' },
          })
        );
      }
      const failure = new Error('registration rejected');
      let adopted: Awaited<ReturnType<typeof store.create>> | undefined;
      await expect(
        phase('create and rollback', () =>
          createRegisteredWorktree(
            {
              listActive: () => phase('list active registrations', () => store.listActive()),
              create: async pending => {
                const reused = await phase('provider adoption', () =>
                  getIsolationProvider().create({
                    workflowType: 'task',
                    identifier: 'concurrent',
                    codebaseId,
                    codebaseName: 'test/repo',
                    canonicalRepoPath: toRepoPath(repo),
                  })
                );
                expect(reused.metadata.provenance).toBe('adopted');
                const otherCodebaseId = randomUUID();
                if (adopter === 'other-codebase') {
                  await phase('insert other codebase', () =>
                    db.query(
                      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
                      [otherCodebaseId, 'duplicate/repo', repo]
                    )
                  );
                }
                adopted = await phase('persist adoption', () =>
                  store.create({
                    ...pending,
                    codebase_id:
                      adopter === 'other-codebase' ? otherCodebaseId : pending.codebase_id,
                    workflow_id: adopter === 'other-workflow' ? 'other' : pending.workflow_id,
                    metadata: { adopted: true, worktree_creation_id: null },
                  })
                );
                const work = join(adopted.working_path, 'in-progress.txt');
                await phase('write in-progress file', () => writeFile(work, 'keep this work'));
                throw failure;
              },
            },
            {
              request: {
                workflowType: 'task',
                identifier: 'concurrent',
                codebaseId,
                codebaseName: 'test/repo',
                canonicalRepoPath: toRepoPath(repo),
              },
              createdByPlatform: 'cli',
            }
          )
        )
      ).rejects.toBe(failure);
      if (!adopted) throw new Error('expected concurrent adoption');
      const retained = adopted;
      expect(await phase('read retained row', () => store.getById(retained.id))).toEqual(adopted);
      expect(
        (await phase('list worktrees', () => listWorktrees(toRepoPath(repo)))).map(
          worktree => worktree.path
        )
      ).toContain(toWorktreePath(adopted.working_path));
      expect(
        await phase('read in-progress file', () =>
          Bun.file(join(retained.working_path, 'in-progress.txt')).text()
        )
      ).toBe('keep this work');
      expect(events).toContainEqual(
        expect.objectContaining({
          msg: 'isolation_store_rollback_skipped_registered',
          worktreePath: adopted.working_path,
        })
      );
      console.error(
        `[rollback timing] ${label} assertions done ${performance.now() - startedAt}ms`
      );
    });
  }

  test(`${persistence}: rollback preserves a resolver adoption of the stale row`, async () => {
    const store =
      persistence === 'sql'
        ? isolation
        : (await (await import('./file-host')).createFileWorkflowHost(join(root, 'store'))).records
            .isolation;
    const stale = await store.create({
      codebase_id: codebaseId,
      workflow_type: 'task',
      workflow_id: 'resolver-race',
      working_path: join(repo, '.worktrees', 'archon', 'task-resolver-race'),
      branch_name: toBranchName('archon/task-resolver-race'),
      metadata: { worktree_creation_id: 'old-creation', adopted: true },
    });
    const failure = new Error('registration rejected');
    await expect(
      createRegisteredWorktree(
        {
          ...store,
          create: async () => {
            const resolver = new IsolationResolver({ store, provider: getIsolationProvider() });
            const result = await resolver.resolve({
              existingEnvId: stale.id,
              platformType: 'cli',
              codebase: { id: codebaseId, name: 'test/repo', defaultCwd: repo },
              hints: { workflowType: 'task', workflowId: 'resolver-race' },
            });
            expect(result.status).toBe('resolved');
            await writeFile(join(stale.working_path, 'in-progress.txt'), 'keep this work');
            throw failure;
          },
        },
        {
          request: {
            workflowType: 'task',
            identifier: 'resolver-race',
            codebaseId,
            codebaseName: 'test/repo',
            canonicalRepoPath: toRepoPath(repo),
          },
          createdByPlatform: 'cli',
        }
      )
    ).rejects.toBe(failure);
    expect(await Bun.file(join(stale.working_path, 'in-progress.txt')).text()).toBe(
      'keep this work'
    );
  });

  test(`${persistence}: a recovered adoption retains the checkout after a failed create`, async () => {
    const store =
      persistence === 'sql'
        ? isolation
        : (await (await import('./file-host')).createFileWorkflowHost(join(root, 'store'))).records
            .isolation;
    const failure = new Error('create finalization failed');
    let registered: Awaited<ReturnType<typeof store.create>> | undefined;
    await expect(
      createRegisteredWorktree(
        {
          listActive: store.listActive,
          create: async input => {
            registered = await store.create({
              ...input,
              metadata: { adopted: true, worktree_creation_id: null },
            });
            throw failure;
          },
        },
        {
          request: {
            workflowType: 'task',
            identifier: 'recovered-adoption',
            codebaseId,
            codebaseName: 'test/repo',
            canonicalRepoPath: toRepoPath(repo),
          },
          createdByPlatform: 'cli',
        }
      )
    ).rejects.toBe(failure);
    if (!registered) throw new Error('expected registration');
    expect(await store.getById(registered.id)).toEqual(registered);
    expect((await listWorktrees(toRepoPath(repo))).map(worktree => worktree.path)).toContain(
      toWorktreePath(registered.working_path)
    );
  });
}

test('a reused worktree stays when its re-registration cannot be written', async () => {
  const input = {
    request: {
      workflowType: 'task' as const,
      identifier: 'kept',
      codebaseId,
      codebaseName: 'test/repo',
      canonicalRepoPath: toRepoPath(repo),
    },
    createdByPlatform: 'cli',
  };
  const first = await createRegisteredWorktree(isolation, input);
  const insertError = new Error('database is locked');

  await expect(
    createRegisteredWorktree(
      {
        listActive: isolation.listActive,
        create: async () => Promise.reject(insertError),
      },
      input
    )
  ).rejects.toBe(insertError);

  expect((await listWorktrees(toRepoPath(repo))).map(worktree => worktree.path)).toContain(
    toWorktreePath(first.env.workingPath)
  );
  expect((await isolation.getById(first.envId))?.status).toBe('active');
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

for (const caller of ['direct', 'resolver'] as const) {
  test(`${caller}: initial registration read failure leaves Git unchanged`, async () => {
    const worktrees = git('worktree', 'list', '--porcelain');
    const branches = git('branch', '--list');
    const failure = new Error('initial registration read failed');
    const store = {
      ...isolation.createIsolationStore(),
      listActive: async () => {
        throw failure;
      },
    };
    const result =
      caller === 'direct'
        ? createRegisteredWorktree(store, {
            request: {
              workflowType: 'task',
              identifier: 'initial-read',
              codebaseId,
              codebaseName: 'test/repo',
              canonicalRepoPath: toRepoPath(repo),
            },
            createdByPlatform: 'cli',
          })
        : new IsolationResolver({ store, provider: getIsolationProvider() }).resolve({
            existingEnvId: null,
            codebase: { id: codebaseId, name: 'test/repo', defaultCwd: repo },
            hints: { workflowType: 'task', workflowId: 'initial-read' },
            platformType: 'cli',
          });
    await expect(result).rejects.toBe(failure);
    expect(git('worktree', 'list', '--porcelain')).toBe(worktrees);
    expect(git('branch', '--list')).toBe(branches);
  });
}
