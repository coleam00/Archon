// @archon-test-isolated
/**
 * Real Git and a real SQLite database: abandonment removes the worktree a run
 * created, with force, and keeps its branch. Runs in its own `bun test`
 * invocation (declared by @archon-test-isolated) because it mock.module's the DB connection.
 */
import { setPlatformPolicies } from '../platforms/registry';
import * as gitModule from '@archon/git';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  chmod,
  symlink,
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  rm,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { getGitCheckoutIdentity, readWorktreeLock, toRepoPath, toBranchName } from '@archon/git';
import {
  IsolationResolver,
  WorktreeProvider,
  WorktreeRegistrationChangedError,
  classifyIsolationError,
  configureIsolation,
  getIsolationProvider,
  worktreeRegistrationMetadata,
} from '@archon/isolation';
import type { IsolationEnvironmentRow, IIsolationStore } from '@archon/isolation';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { setLogLevel } from '@archon/paths';

setLogLevel('silent');
const { SqliteAdapter, sqliteDialect } = await import('../db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');
mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const isolationDb = await import('../db/isolation-environments');
const { claimPendingWorkflowRun, updateWorkflowRun, createWorkflowRun } = await import(
  '../db/workflows'
);
const {
  assessCompletedRunWorktree,
  cleanupStaleWorktrees,
  cleanupMergedWorktrees,
  onConversationClosed,
  reclaimRunWorktree,
  releaseCompletedRunWorktree,
  removeEnvironment,
  runScheduledCleanup,
} = await import('./cleanup-service');
const codebaseDb = await import('../db/codebases');

async function git(path: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', path, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw new Error(err);
  return out.trim();
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path);
  await git(path, 'init', '-q', '-b', 'main');
  await git(path, 'config', 'user.name', 'Test');
  await git(path, 'config', 'user.email', 'test@example.com');
  await git(path, 'config', 'commit.gpgsign', 'false');
}

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

const track = trackTempRoots();
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
let root: string;
let repo: string;
let codebaseId: string;
let env: IsolationEnvironmentRow;
let run: WorkflowRun;
let store: IIsolationStore;
let provider: WorktreeProvider;
const request = () => ({
  canonicalRepoPath: toRepoPath(repo),
  codebaseId,
  codebaseName: 'test/repo',
  workflowType: 'task' as const,
  identifier: 'release',
});
const status = async () => (await isolationDb.getById(env.id))?.status;

test.each(['replacement', 'partial', 'dirty'] as const)(
  'conversation close retains references and reports %s cleanup failure',
  async mode => {
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations
        (id, platform_type, platform_conversation_id, codebase_id, isolation_env_id, cwd)
       VALUES ($1, 'github', $1, $2, $3, $4)`,
      [conversationId, codebaseId, env.id, env.working_path]
    );
    if (mode === 'replacement') {
      await git(repo, 'worktree', 'remove', env.working_path);
      await git(root, 'clone', '-q', repo, env.working_path);
    } else if (mode === 'dirty') {
      await writeFile(join(env.working_path, 'file'), 'operator edits');
    }
    const partial =
      mode === 'partial'
        ? spyOn(getIsolationProvider(), 'destroy').mockResolvedValue({
            worktreeRemoved: true,
            directoryClean: false,
            branchDeleted: null,
            remoteBranchDeleted: null,
            warnings: ['Retained directory'],
          })
        : undefined;
    try {
      await expect(onConversationClosed('github', conversationId)).rejects.toThrow();
    } finally {
      partial?.mockRestore();
    }
    const { rows } = await db.query<{ isolation_env_id: string; cwd: string }>(
      'SELECT isolation_env_id, cwd FROM remote_agent_conversations WHERE id = $1',
      [conversationId]
    );
    expect(rows[0]).toEqual({ isolation_env_id: env.id, cwd: env.working_path });
    expect(await status()).toBe('active');
    expect(await readFile(join(env.working_path, 'file'), 'utf8')).toBe(
      mode === 'dirty' ? 'operator edits' : 'original'
    );
  }
);

test.each(['claim', 'bind', 'create'] as const)(
  'conversation close rechecks %s acquisition after its last preliminary ownership check',
  async mode => {
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations
      (id, platform_type, platform_conversation_id, codebase_id, isolation_env_id, cwd)
     VALUES ($1, 'github', $1, $2, $3, $4)`,
      [conversationId, codebaseId, env.id, env.working_path]
    );
    const pendingId = await seedRunAt(null, 'pending');
    const checked = Promise.withResolvers<void>();
    const continueCleanup = Promise.withResolvers<void>();
    const lookup = isolationDb.getLiveRunOwningEnv;
    const racing = spyOn(isolationDb, 'getLiveRunOwningEnv').mockImplementation(async (...args) => {
      const owner = await lookup(...args);
      checked.resolve();
      await continueCleanup.promise;
      return owner;
    });
    const cleanup = onConversationClosed('github', conversationId);
    try {
      await checked.promise;
      let acquiringId = pendingId;
      if (mode === 'bind') await updateWorkflowRun(pendingId, { working_path: env.working_path });
      if (mode === 'create')
        acquiringId = (
          await createWorkflowRun({
            workflow_name: 'new-owner',
            user_message: '',
            codebase_id: codebaseId,
            working_path: env.working_path,
          })
        ).id;
      expect(await claimPendingWorkflowRun(acquiringId, env.working_path)).toMatchObject({
        status: 'running',
      });
      continueCleanup.resolve();
      await expect(cleanup).rejects.toThrow('also uses this checkout');
    } finally {
      continueCleanup.resolve();
      await Promise.allSettled([cleanup]);
      racing.mockRestore();
    }
    expect(await status()).toBe('active');
    expect(existsSync(env.working_path)).toBe(true);
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain(env.working_path);
    expect(await git(repo, 'branch', '--list', env.branch_name)).not.toBe('');
  }
);

test.each(['active', 'destroyed'] as const)(
  'conversation close clears references after cleanup of a %s environment',
  async initialStatus => {
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations
        (id, platform_type, platform_conversation_id, codebase_id, isolation_env_id, cwd)
       VALUES ($1, 'github', $1, $2, $3, $4)`,
      [conversationId, codebaseId, env.id, env.working_path]
    );
    if (initialStatus === 'destroyed') await removeEnvironment(env);

    await onConversationClosed('github', conversationId);

    const { rows } = await db.query<{ isolation_env_id: string | null; cwd: string | null }>(
      'SELECT isolation_env_id, cwd FROM remote_agent_conversations WHERE id = $1',
      [conversationId]
    );
    expect(rows[0]).toEqual({ isolation_env_id: null, cwd: null });
    expect(await status()).toBe('destroyed');
    expect(existsSync(env.working_path)).toBe(false);
  }
);

beforeEach(async () => {
  setPlatformPolicies([]);
  root = track(await realpath(await mkdtemp(join(tmpdir(), 'archon-release-'))));
  process.env.GIT_CONFIG_GLOBAL = join(root, '.gitconfig');
  repo = join(root, 'repo');
  await initRepo(repo);
  await writeFile(join(repo, '.gitignore'), '*.secret\n');
  await writeFile(join(repo, 'file'), 'original');
  await writeFile(join(repo, 'flagged'), 'original');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'initial');
  const remote = join(root, 'remote.git');
  await mkdir(remote);
  await git(remote, 'init', '--bare', '-q');
  await git(repo, 'remote', 'add', 'upstream', remote);
  await git(repo, 'push', '-q', 'upstream', 'main');
  const config = async () => ({
    baseBranch: toBranchName('main'),
    remote: 'upstream',
    path: '.worktrees',
  });
  configureIsolation(config);
  provider = new WorktreeProvider(config);
  codebaseId = randomUUID();
  await db.query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, 'test/repo', $2)`,
    [codebaseId, repo]
  );
  const created = await provider.create(request());
  if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
  env = await isolationDb.create({
    codebase_id: codebaseId,
    workflow_type: 'task',
    workflow_id: 'release',
    working_path: created.workingPath,
    branch_name: created.branchName,
    metadata: { ...worktreeRegistrationMetadata(created.metadata) },
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
    metadata: { owned_worktree: { envId: env.id, creationId: created.metadata.creationId } },
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: created.workingPath,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    origin: null,
  };
  store = isolationDb.createIsolationStore();
});

// A test may leave a read-only directory behind; make it removable for cleanup.
afterEach(async () => {
  if (originalGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
  if (existsSync(root)) await Bun.spawn(['chmod', '-R', 'u+w', root]).exited;
});

/**
 * Recreate the run's worktree under a symlinked base. Git lists it by its
 * symlink-resolved path while Archon records the path it asked for.
 */
async function useSymlinkedBase(): Promise<void> {
  await mkdir(join(root, 'real-base'));
  await symlink(join(root, 'real-base'), join(repo, '.wt-link'));
  const config = async () => ({
    baseBranch: toBranchName('main'),
    remote: 'upstream',
    path: '.wt-link',
  });
  configureIsolation(config);
  const created = await new WorktreeProvider(config).create({ ...request(), identifier: 'linked' });
  if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
  expect(created.workingPath).toContain('.wt-link');
  env = await isolationDb.create({
    codebase_id: codebaseId,
    workflow_type: 'task',
    workflow_id: 'linked',
    working_path: created.workingPath,
    branch_name: created.branchName,
    metadata: { ...worktreeRegistrationMetadata(created.metadata) },
  });
  run.working_path = created.workingPath;
  run.metadata = { owned_worktree: { envId: env.id, creationId: created.metadata.creationId } };
}

for (const persistence of ['sql', 'file'] as const) {
  test(`${persistence}: reclaim failure rolls back retirement and preserves its evidence`, async () => {
    const target =
      persistence === 'sql'
        ? store
        : (
            await (
              await import('../workflows/file-host')
            ).createFileWorkflowHost(join(root, 'store'))
          ).records.isolation;
    if (persistence === 'file') {
      env = await target.create({
        ...env,
        branch_name: toBranchName(env.branch_name),
        created_by_platform: undefined,
        created_by_user_id: undefined,
      });
      run.metadata = {
        owned_worktree: { envId: env.id, creationId: env.metadata.worktree_creation_id },
      };
    }
    await expect(
      reclaimRunWorktree(run, {
        ...target,
        withWorktreeRegistration: (observed, remove) =>
          target.withWorktreeRegistration(observed, () =>
            remove(async () => {
              throw new Error('retirement write failed');
            })
          ),
      })
    ).rejects.toThrow('retirement write failed');
    expect((await target.getById(env.id))?.status).toBe('active');
    expect(existsSync(env.working_path)).toBe(true);
  });
}

describe('owned worktree release', () => {
  test('a removal Git abandons halfway is finished, not left unretryable', async () => {
    const locked = join(env.working_path, 'locked');
    await mkdir(locked);
    await writeFile(join(locked, 'file'), 'cannot unlink');
    await chmod(locked, 0o555);

    const result = await reclaimRunWorktree(run, store);

    expect(result.released?.path).toBe(env.working_path);
    expect(existsSync(env.working_path)).toBe(false);
    expect(await status()).toBe('destroyed');
    expect(await git(repo, 'rev-parse', '--verify', env.branch_name)).toBeTruthy();
  });

  test('under a symlinked base, a failed removal Git still tracks keeps the checkout', async () => {
    await useSymlinkedBase();
    const originalExec = gitModule.execFileAsync;
    const failing = spyOn(gitModule, 'execFileAsync').mockImplementation(
      async (file, args, options) => {
        if (file === 'git' && args.includes('worktree') && args.includes('remove'))
          throw new Error('simulated remove failure');
        return originalExec(file, args, options);
      }
    );
    try {
      await expect(reclaimRunWorktree(run, store)).rejects.toThrow('simulated remove failure');
    } finally {
      failing.mockRestore();
    }
    expect(existsSync(join(env.working_path, 'file'))).toBe(true);
    expect(await status()).toBe('active');
    expect(await readWorktreeLock(gitModule.toWorktreePath(env.working_path))).toBeNull();
  });

  test('under a symlinked base, a vanished but registered checkout is retained', async () => {
    await useSymlinkedBase();
    await git(env.working_path, 'checkout', '--detach', '-q');
    await rm(env.working_path, { recursive: true });
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow('still registered');
    expect(await status()).toBe('active');
  });

  test.each(['sql', 'file'] as const)(
    '%s: a removal that fails while still registered can be retried',
    async persistence => {
      const target =
        persistence === 'sql'
          ? store
          : (
              await (
                await import('../workflows/file-host')
              ).createFileWorkflowHost(join(root, 'store'))
            ).records.isolation;
      if (persistence === 'file') {
        env = await target.create({
          codebase_id: codebaseId,
          workflow_type: 'task',
          workflow_id: 'release',
          working_path: env.working_path,
          branch_name: toBranchName(env.branch_name),
          metadata: env.metadata,
        });
        run.metadata = {
          owned_worktree: { envId: env.id, creationId: env.metadata.worktree_creation_id },
        };
      }
      const originalExec = gitModule.execFileAsync;
      const failing = spyOn(gitModule, 'execFileAsync').mockImplementation(
        async (file, args, options) => {
          if (file === 'git' && args.includes('worktree') && args.includes('remove'))
            throw new Error('simulated remove failure');
          return originalExec(file, args, options);
        }
      );
      try {
        await expect(reclaimRunWorktree(run, target)).rejects.toThrow('simulated remove failure');
      } finally {
        failing.mockRestore();
      }
      expect(existsSync(join(env.working_path, 'file'))).toBe(true);
      expect((await target.getById(env.id))?.status).toBe('active');
      expect(await readWorktreeLock(gitModule.toWorktreePath(env.working_path))).toBeNull();

      const result = await reclaimRunWorktree(run, target);
      expect(result.released?.path).toBe(env.working_path);
      expect(existsSync(env.working_path)).toBe(false);
      expect((await target.getById(env.id))?.status).toBe('destroyed');
    }
  );

  test('discards uncommitted work, hidden index flags, and unpushed commits; keeps the branch', async () => {
    const wt = env.working_path;
    await writeFile(join(wt, 'file'), 'unstaged');
    await writeFile(join(wt, 'staged'), 'staged');
    await git(wt, 'add', 'staged');
    await writeFile(join(wt, 'untracked'), 'untracked');
    await writeFile(join(wt, 'operator.secret'), 'ignored');
    await git(wt, 'update-index', '--assume-unchanged', 'flagged');
    await git(wt, 'update-index', '--skip-worktree', '.gitignore');
    await writeFile(join(wt, 'flagged'), 'hidden edit');
    await git(wt, 'commit', '-qm', 'unpushed', '--', 'staged');
    const head = await git(wt, 'rev-parse', 'HEAD');

    const result = await reclaimRunWorktree(run, store);

    expect(result).toEqual({ released: { path: wt, branch: env.branch_name }, warnings: [] });
    expect(existsSync(wt)).toBe(false);
    expect(await status()).toBe('destroyed');
    expect(await git(repo, 'rev-parse', '--verify', env.branch_name)).toBe(head);
    await expect(reclaimRunWorktree(run, store)).resolves.toEqual({ warnings: [] });
  });

  test('removes a worktree with an initialized submodule', async () => {
    const lib = join(root, 'lib');
    await initRepo(lib);
    await writeFile(join(lib, 'lib'), 'lib');
    await git(lib, 'add', '.');
    await git(lib, 'commit', '-qm', 'lib');
    await git(
      env.working_path,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      lib,
      'lib'
    );
    await git(env.working_path, 'commit', '-qm', 'add submodule');
    expect(existsSync(join(env.working_path, 'lib', 'lib'))).toBe(true);

    await reclaimRunWorktree(run, store);

    expect(existsSync(env.working_path)).toBe(false);
    expect(await status()).toBe('destroyed');
  });

  test('a claimable run on the checkout refuses release and leaves it usable', async () => {
    const other = await seedRunAt(env.working_path, 'failed');
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow(`claimable run ${other}`);
    expect(existsSync(env.working_path)).toBe(true);
    expect(await status()).toBe('active');
    expect(await readWorktreeLock(gitModule.toWorktreePath(env.working_path))).toBeNull();
  });

  test('a detached adoption row without a path cannot claim the checkout once release begins', async () => {
    const adopter = await seedRunAt(null, 'pending');
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const originalExec = gitModule.execFileAsync;
    const exec = spyOn(gitModule, 'execFileAsync').mockImplementation(
      async (file, args, options) => {
        if (file === 'git' && args.includes('worktree') && args.includes('remove')) {
          entered.resolve();
          await finish.promise;
        }
        return originalExec(file, args, options);
      }
    );
    const release = reclaimRunWorktree(run, store);
    try {
      await entered.promise;
      const claim = claimPendingWorkflowRun(adopter, env.working_path);
      finish.resolve();
      await release;
      expect(await claim).toBeNull();
    } finally {
      finish.resolve();
      await release.catch(() => {});
      exec.mockRestore();
    }
    expect(existsSync(env.working_path)).toBe(false);
  });

  test('a run that reuses the checkout during removal can neither start nor adopt it', async () => {
    const originalExec = gitModule.execFileAsync;
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const exec = spyOn(gitModule, 'execFileAsync').mockImplementation(
      async (file, args, options) => {
        if (file === 'git' && args.includes('worktree') && args.includes('remove')) {
          entered.resolve();
          await finish.promise;
        }
        return originalExec(file, args, options);
      }
    );
    const release = reclaimRunWorktree(run, store);
    try {
      await entered.promise;
      const lateRun = seedRunAt(env.working_path, 'pending');
      const adoption = await provider.create(request()).catch((err: unknown) => err);
      expect(String(adoption)).toContain('an abandoned run is removing it');
      if (!(adoption instanceof Error)) throw new Error('expected adoption refusal');
      expect(classifyIsolationError(adoption)).toBe(
        '**Error:** Refused to adopt an existing directory at the worktree path. ' +
          'Remove it or choose a different branch/codebase registration.'
      );
      finish.resolve();
      await release;
      expect(await claimPendingWorkflowRun(await lateRun)).toBeNull();
    } finally {
      finish.resolve();
      await release.catch(() => {});
      exec.mockRestore();
    }
    expect(existsSync(env.working_path)).toBe(false);

    // Once a fresh checkout is registered at the path again, runs there start normally.
    const fresh = await provider.create(request());
    await isolationDb.create({
      codebase_id: codebaseId,
      workflow_type: 'task',
      workflow_id: 'release',
      working_path: fresh.workingPath,
      branch_name: fresh.branchName,
    });
    expect(
      await claimPendingWorkflowRun(await seedRunAt(fresh.workingPath, 'pending'))
    ).not.toBeNull();
  });

  test("an operator's lock refuses release", async () => {
    await git(repo, 'worktree', 'lock', '--reason', 'operator', env.working_path);
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow('Could not release worktree');
    expect(existsSync(env.working_path)).toBe(true);
    expect(await status()).toBe('active');
    expect(await readWorktreeLock(gitModule.toWorktreePath(env.working_path))).toEqual({
      reason: 'operator',
    });
  });

  test('mismatched marker refuses replacement estate', async () => {
    const { gitDir } = await getGitCheckoutIdentity(env.working_path);
    await writeFile(join(gitDir, 'archon-creation-id'), 'replacement');
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow('identity changed');
    expect(existsSync(env.working_path)).toBe(true);
    expect(await status()).toBe('active');
  });

  test('a vanished but registered detached checkout is retained, not falsely finalized', async () => {
    await git(env.working_path, 'checkout', '--detach', '-q');
    await rm(env.working_path, { recursive: true });
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow('still registered');
    expect(await status()).toBe('active');
  });

  test('a residual directory survives removal and keeps the row active', async () => {
    const originalExec = gitModule.execFileAsync;
    const exec = spyOn(gitModule, 'execFileAsync').mockImplementation(
      async (file, args, options) => {
        const result = await originalExec(file, args, options);
        if (file === 'git' && args.includes('worktree') && args.includes('remove')) {
          await mkdir(env.working_path);
          await writeFile(join(env.working_path, 'late.secret'), 'late residue');
        }
        return result;
      }
    );
    try {
      await expect(reclaimRunWorktree(run, store)).rejects.toThrow('filesystem removal incomplete');
      expect(await readFile(join(env.working_path, 'late.secret'), 'utf8')).toBe('late residue');
      expect(await status()).toBe('active');
    } finally {
      exec.mockRestore();
    }
  });
});

describe('completed run worktree release', () => {
  const readers = () => ({
    getCodebase: codebaseDb.getCodebase,
    getLiveRunOwningEnv: isolationDb.getLiveRunOwningEnv,
  });
  const assess = () =>
    assessCompletedRunWorktree({ ...run, status: 'completed' }, store, readers());
  const commitInWorktree = async (): Promise<void> => {
    await writeFile(join(env.working_path, 'work'), 'work');
    await git(env.working_path, 'add', 'work');
    await git(env.working_path, 'commit', '-qm', 'work');
  };

  beforeEach(async () => {
    await git(join(root, 'remote.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main');
    await mkdir(join(repo, '.archon'));
    await writeFile(join(repo, '.archon', 'config.yaml'), 'worktree:\n  remote: upstream\n');
  });

  test.each(['sql', 'file'] as const)(
    '%s: a clean checkout whose commits are all on a remote is removed, keeping its branch',
    async persistence => {
      const target =
        persistence === 'sql'
          ? store
          : (
              await (
                await import('../workflows/file-host')
              ).createFileWorkflowHost(join(root, 'store'))
            ).records.isolation;
      if (persistence === 'file') {
        env = await target.create({
          codebase_id: codebaseId,
          workflow_type: 'task',
          workflow_id: 'release',
          working_path: env.working_path,
          branch_name: toBranchName(env.branch_name),
          metadata: env.metadata,
        });
        run.metadata = {
          owned_worktree: { envId: env.id, creationId: env.metadata.worktree_creation_id },
        };
      }
      const completed = { ...run, status: 'completed' as const };

      expect(await assessCompletedRunWorktree(completed, target, readers())).toEqual({
        disposition: 'release',
      });
      let inClaim = false;
      const registrationStore: IIsolationStore = {
        ...target,
        withWorktreeRegistration: async (observed, remove) => {
          inClaim = true;
          try {
            return await target.withWorktreeRegistration(observed, remove);
          } finally {
            inClaim = false;
          }
        },
      };
      const networkClaims: boolean[] = [];
      const originalExec = gitModule.execFileAsync;
      const exec = spyOn(gitModule, 'execFileAsync').mockImplementation(
        async (file, args, options) => {
          if (args.includes('ls-remote')) networkClaims.push(inClaim);
          return originalExec(file, args, options);
        }
      );
      try {
        await releaseCompletedRunWorktree(completed, registrationStore, readers());
        expect(networkClaims).toEqual([false]);
      } finally {
        exec.mockRestore();
      }

      expect(existsSync(env.working_path)).toBe(false);
      expect((await target.getById(env.id))?.status).toBe('destroyed');
      expect(await git(repo, 'branch', '--list', env.branch_name)).toContain(env.branch_name);
    }
  );

  test('a commit on no remote keeps the checkout', async () => {
    await commitInWorktree();
    expect(await assess()).toEqual({
      disposition: 'retained',
      reason: 'unpushed_commits',
      detail: '1 commit(s) on no remote',
    });
  });

  test('uncommitted changes keep the checkout', async () => {
    await writeFile(join(env.working_path, 'file'), 'edited');
    expect(await assess()).toEqual({ disposition: 'retained', reason: 'uncommitted_changes' });
  });

  test('a branch published to the configured remote waits for the merged sweep', async () => {
    await commitInWorktree();
    await git(env.working_path, 'push', '-q', 'upstream', `HEAD:refs/heads/${env.branch_name}`);
    await git(repo, 'fetch', '-q', 'upstream');
    expect(await assess()).toEqual({ disposition: 'retained', reason: 'published_branch' });
  });

  test('a published branch with no remote-tracking ref still waits for the merged sweep', async () => {
    await git(
      env.working_path,
      'push',
      '-q',
      join(root, 'remote.git'),
      `HEAD:refs/heads/${env.branch_name}`
    );
    // Git on Windows matches the path to the upstream URL and writes the tracking ref anyway.
    await git(repo, 'update-ref', '-d', `refs/remotes/upstream/${env.branch_name}`);
    expect(await git(repo, 'branch', '-r', '--list', `upstream/${env.branch_name}`)).toBe('');
    expect(await assess()).toEqual({ disposition: 'retained', reason: 'published_branch' });
  });

  test('a remote that cannot be read keeps the checkout', async () => {
    await git(repo, 'remote', 'set-url', 'upstream', join(root, 'missing.git'));
    expect(await assess()).toMatchObject({ disposition: 'retained', reason: 'check_failed' });
  });

  test('the completing run does not hold its own checkout, another claimable run does', async () => {
    run.id = await seedRunAt(env.working_path, 'running');
    expect(await assess()).toEqual({ disposition: 'release' });

    const other = await seedRunAt(env.working_path, 'paused');
    expect(await assess()).toEqual({
      disposition: 'retained',
      reason: 'in_use',
      detail: `run ${other} (paused)`,
    });
  });

  test('a check that cannot run is reported, not thrown', async () => {
    run.metadata = { owned_worktree: { envId: env.id, creationId: randomUUID() } };
    expect(await assess()).toEqual({
      disposition: 'retained',
      reason: 'check_failed',
      detail: 'creation proof does not match its isolation record',
    });
  });

  test.each(['uncommitted_changes', 'unpushed_commits'] as const)(
    'work arriving before the registration claim is checked under the worktree lock (%s)',
    async reason => {
      const real = store;
      const racing: IIsolationStore = {
        ...real,
        withWorktreeRegistration: async (observed, remove) => {
          await writeFile(join(env.working_path, 'late'), 'late work');
          if (reason === 'unpushed_commits') {
            await git(env.working_path, 'add', 'late');
            await git(env.working_path, 'commit', '-qm', 'late work');
          }
          return real.withWorktreeRegistration(observed, remove);
        },
      };
      await expect(
        releaseCompletedRunWorktree({ ...run, status: 'completed' }, racing, readers())
      ).rejects.toThrow(`no longer releasable: ${reason}`);
      expect(await readFile(join(env.working_path, 'late'), 'utf8')).toBe('late work');
      expect(await status()).toBe('active');
      expect(await readWorktreeLock(gitModule.toWorktreePath(env.working_path))).toBeNull();
    }
  );

  test('work that appears after the assessment refuses the release', async () => {
    const completed = { ...run, status: 'completed' as const };
    expect(await assessCompletedRunWorktree(completed, store, readers())).toEqual({
      disposition: 'release',
    });
    await writeFile(join(env.working_path, 'late'), 'late work');

    await expect(releaseCompletedRunWorktree(completed, store, readers())).rejects.toThrow(
      'no longer releasable: uncommitted_changes'
    );
    expect(await readFile(join(env.working_path, 'late'), 'utf8')).toBe('late work');
    expect(await status()).toBe('active');
  });
});

describe('the age sweep keeps work that exists nowhere else', () => {
  const age = (id: string): Promise<unknown> =>
    db.query(
      `UPDATE remote_agent_isolation_environments SET created_at = datetime('now', '-30 days') WHERE id = $1`,
      [id]
    );

  test('a stale environment with no run keeps a commit on no remote', async () => {
    await writeFile(join(env.working_path, 'work'), 'work');
    await git(env.working_path, 'add', 'work');
    await git(env.working_path, 'commit', '-qm', 'work');
    await age(env.id);

    const result = await cleanupStaleWorktrees(codebaseId, repo);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([
      {
        branchName: env.branch_name,
        reason: `1 unpushed commit(s); remove it explicitly with archon complete ${env.branch_name} --force`,
      },
    ]);
    expect(existsSync(env.working_path)).toBe(true);
    expect(await status()).toBe('active');
  });

  test('a stale environment with no run and nothing unpushed is still removed', async () => {
    await age(env.id);
    const result = await cleanupStaleWorktrees(codebaseId, repo);
    expect(result.removed).toEqual([env.branch_name]);
    expect(await status()).toBe('destroyed');
  });

  test('a missing checkout keeps the branch it created while it holds a commit on no remote', async () => {
    await writeFile(join(env.working_path, 'work'), 'work');
    await git(env.working_path, 'add', 'work');
    await git(env.working_path, 'commit', '-qm', 'work');
    const tip = await git(env.working_path, 'rev-parse', 'HEAD');
    await git(repo, 'worktree', 'remove', env.working_path);

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: env.id,
      reason: `path missing but 1 unpushed commit(s); remove it explicitly with archon complete ${env.branch_name} --force`,
    });
    expect(await status()).toBe('active');
    expect(await git(repo, 'rev-parse', env.branch_name)).toBe(tip);
  });
});

test('ordinary cleanup preserves a replacement clone and its active record', async () => {
  await git(repo, 'worktree', 'remove', env.working_path);
  await git(root, 'clone', '-q', repo, env.working_path);
  await writeFile(join(env.working_path, 'operator-file'), 'keep me');

  const error = await removeEnvironment(env, { force: true }).catch((error: unknown) => error);

  expect(await readFile(join(env.working_path, 'operator-file'), 'utf8')).toBe('keep me');
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain('ownership');
  expect(await status()).toBe('active');
  expect(await git(repo, 'branch', '--list', env.branch_name)).toContain(env.branch_name);
});

test('ordinary cleanup removes a proven checkout and its branch', async () => {
  const result = await removeEnvironment(env);
  expect(result.worktreeRemoved).toBe(true);
  expect(result.branchDeleted).toBe(true);
  expect(existsSync(env.working_path)).toBe(false);
  expect(await status()).toBe('destroyed');
  expect(await git(repo, 'branch', '--list', env.branch_name)).toBe('');
});

test.each(['worktreeRemoved', 'directoryClean'] as const)(
  'incomplete %s preserves the active registration and published remote ref',
  async field => {
    await git(repo, 'remote', 'rename', 'upstream', 'origin');
    await git(repo, 'push', '-q', 'origin', env.branch_name);
    const ref = `refs/heads/${env.branch_name}`;
    const published = await git(repo, 'ls-remote', 'origin', ref);
    expect(published).toContain(ref);
    const partial = spyOn(getIsolationProvider(), 'destroy').mockResolvedValue({
      worktreeRemoved: true,
      directoryClean: true,
      branchDeleted: null,
      remoteBranchDeleted: null,
      warnings: ['Retained directory'],
      [field]: false,
    });
    try {
      const result = await removeEnvironment(env, { deleteRemoteBranch: true });
      expect(result.skippedReason).toContain('filesystem removal incomplete');
      expect(await status()).toBe('active');
      expect(await git(repo, 'ls-remote', 'origin', ref)).toBe(published);
    } finally {
      partial.mockRestore();
    }
  }
);

test('merged cleanup retires locally and reports the retained published branch', async () => {
  await git(repo, 'remote', 'rename', 'upstream', 'origin');
  await git(join(root, 'remote.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await git(repo, 'push', '-q', 'origin', env.branch_name);
  const ref = `refs/heads/${env.branch_name}`;
  const published = await git(repo, 'ls-remote', 'origin', ref);
  expect(published).toContain(ref);
  const result = await cleanupMergedWorktrees(codebaseId, repo);
  expect(result.removed).toEqual([env.branch_name]);
  expect(result.warnings).toEqual([
    {
      branchName: env.branch_name,
      message: expect.stringContaining('Remote branch retained'),
    },
  ]);
  expect(await status()).toBe('destroyed');
  expect(existsSync(env.working_path)).toBe(false);
  expect(await git(repo, 'ls-remote', 'origin', ref)).toBe(published);
});

test.each([false, true].flatMap(force => [false, true].map(split => ({ force, split }))))(
  'local cleanup retains an unchanged remote ref with a warning (force=$force, split=$split)',
  async ({ force, split }) => {
    const pushRemote = split ? join(root, 'push.git') : join(root, 'remote.git');
    await git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'));
    if (split) {
      await git(root, 'init', '--bare', '-q', pushRemote);
      await git(repo, 'remote', 'set-url', '--push', 'origin', pushRemote);
    }
    await git(repo, 'push', '-q', 'origin', env.branch_name);
    const ref = `refs/heads/${env.branch_name}`;
    const published = await git(repo, 'ls-remote', pushRemote, ref);
    expect(published).toContain(ref);
    const result = await removeEnvironment(env, { force, deleteRemoteBranch: true });
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.warnings.join(' ')).toContain('Remote branch retained');
    expect(await status()).toBe('destroyed');
    expect(await git(repo, 'ls-remote', pushRemote, ref)).toBe(published);
  }
);

test.each(
  [false, true].flatMap(force =>
    [false, true].flatMap(split =>
      ['same', 'advanced', 'absent'].map(tip => ({ force, split, tip }))
    )
  )
)(
  'remote cleanup retains a replacement published after commit (force=$force, split=$split, tip=$tip)',
  async ({ force, split, tip }) => {
    const published = tip !== 'absent';
    await git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'));
    const pushRemote = split ? join(root, 'push.git') : join(root, 'remote.git');
    if (split) {
      await git(root, 'init', '--bare', '-q', pushRemote);
      await git(repo, 'remote', 'set-url', '--push', 'origin', pushRemote);
    }
    if (published) await git(repo, 'push', '-q', 'origin', env.branch_name);
    const originalOid = await git(repo, 'rev-parse', env.branch_name);
    const acquire = isolationDb.withWorktreeRegistration;
    let replacementOid = '';
    let replacementId = '';
    const claim = spyOn(isolationDb, 'withWorktreeRegistration').mockImplementation(
      async (observed, remove) => {
        const result = await acquire(observed, remove);
        expect(await status()).toBe('destroyed');
        const replacement = await provider.create(request());
        const registered = await isolationDb.create({
          codebase_id: codebaseId,
          provider: 'worktree',
          working_path: replacement.workingPath,
          branch_name: replacement.branchName,
          workflow_type: env.workflow_type,
          workflow_id: env.workflow_id,
          metadata: { ...worktreeRegistrationMetadata(replacement.metadata) },
        });
        replacementId = registered.id;
        if (tip === 'advanced')
          await git(replacement.workingPath, 'commit', '--allow-empty', '-qm', 'replacement');
        replacementOid = await git(replacement.workingPath, 'rev-parse', 'HEAD');
        await git(replacement.workingPath, 'push', '-q', 'origin', replacement.branchName);
        return result;
      }
    );
    try {
      const result = await removeEnvironment(env, { force, deleteRemoteBranch: true });
      if (tip === 'advanced') expect(replacementOid).not.toBe(originalOid);
      else expect(replacementOid).toBe(originalOid);
      expect(await git(repo, 'ls-remote', pushRemote, `refs/heads/${env.branch_name}`)).toBe(
        `${replacementOid}\trefs/heads/${env.branch_name}`
      );
      expect((await isolationDb.getById(replacementId))?.status).toBe('active');
      expect(existsSync(env.working_path)).toBe(true);
      expect(result.worktreeRemoved).toBe(true);
      expect(result.warnings.join(' ')).toContain('Remote branch retained');
    } finally {
      claim.mockRestore();
    }
  }
);

test('remote cleanup refuses network work without registration ownership proof', async () => {
  const originalExec = gitModule.execFileAsync;
  const network: string[] = [];
  const exec = spyOn(gitModule, 'execFileAsync').mockImplementation(async (file, args, options) => {
    if (args.includes('push') || args.includes('ls-remote')) network.push(args.join(' '));
    return originalExec(file, args, options);
  });
  try {
    const result = await removeEnvironment(env, { deleteRemoteBranch: true });
    expect(network).toEqual([]);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.warnings.join(' ')).toContain('Remote branch retained');
    expect(await status()).toBe('destroyed');
  } finally {
    exec.mockRestore();
  }
});

test('ordinary cleanup accepts an unchanged legacy registration with joined codebase fields', async () => {
  const { worktree_registration_id, ...metadata } = env.metadata;
  await db.query('UPDATE remote_agent_isolation_environments SET metadata = $1 WHERE id = $2', [
    JSON.stringify(metadata),
    env.id,
  ]);
  const selected = (await isolationDb.listAllActiveWithCodebase()).find(row => row.id === env.id);
  if (!selected) throw new Error('Missing joined environment fixture');

  const result = await removeEnvironment(selected);

  expect(result.worktreeRemoved).toBe(true);
  expect(await status()).toBe('destroyed');
  expect(existsSync(env.working_path)).toBe(false);
});

test('ordinary cleanup keeps an existing branch the environment checked out', async () => {
  await git(repo, 'checkout', '-q', '-b', 'operator-work');
  await writeFile(join(repo, 'unpushed'), 'only copy');
  await git(repo, 'add', 'unpushed');
  await git(repo, 'commit', '-qm', 'unpushed');
  await git(repo, 'checkout', '-q', 'main');
  const tip = await git(repo, 'rev-parse', 'operator-work');
  const created = await provider.create({
    ...request(),
    identifier: 'operator-work',
    taskBranch: { kind: 'new', branch: toBranchName('operator-work') },
  });
  if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
  const existing = await isolationDb.create({
    codebase_id: codebaseId,
    workflow_type: 'task',
    workflow_id: 'operator-work',
    working_path: created.workingPath,
    branch_name: created.branchName,
    metadata: { ...worktreeRegistrationMetadata(created.metadata) },
  });

  const result = await removeEnvironment(existing);

  expect(result.worktreeRemoved).toBe(true);
  expect(result.branchDeleted).toBeNull();
  expect(await git(repo, 'rev-parse', 'operator-work')).toBe(tip);
});

test('listing retains a replacement directory without a Git entry', async () => {
  await git(repo, 'worktree', 'remove', env.working_path);
  await mkdir(env.working_path);
  await writeFile(join(env.working_path, 'operator-file'), 'keep me');
  const { listEnvironments } = await import('../operations/isolation-operations');
  const result = await listEnvironments();
  expect(result.codebases.flatMap(codebase => codebase.environments).map(env => env.id)).toContain(
    env.id
  );
  expect(await status()).toBe('active');
  await expect(removeEnvironment(env, { force: true })).rejects.toThrow('ownership');
  expect(await readFile(join(env.working_path, 'operator-file'), 'utf8')).toBe('keep me');
});

test('ordinary cleanup removes a proven checkout under a symlinked base', async () => {
  await useSymlinkedBase();
  const result = await removeEnvironment(env);
  expect(result.worktreeRemoved).toBe(true);
  expect(existsSync(env.working_path)).toBe(false);
  expect(await status()).toBe('destroyed');
});

test('worktree sweep keeps a missing-path container discoverable for container cleanup', async () => {
  const container = await seedMissingPathContainer();
  await runScheduledCleanup();
  expect((await isolationDb.getById(container.id))?.status).toBe('active');
  expect((await isolationDb.listActiveContainerEnvironments()).map(row => row.id)).toContain(
    container.id
  );
});

test('conversation close retains a container and its conversation reference', async () => {
  const container = await seedMissingPathContainer();
  const conversationId = randomUUID();
  await db.query(
    `INSERT INTO remote_agent_conversations
      (id, platform_type, platform_conversation_id, codebase_id, isolation_env_id, cwd)
     VALUES ($1, 'github', $1, $2, $3, $4)`,
    [conversationId, codebaseId, container.id, container.working_path]
  );
  await expect(onConversationClosed('github', conversationId)).rejects.toThrow('not a worktree');
  expect((await isolationDb.getById(container.id))?.status).toBe('active');
  const { rows } = await db.query<{ isolation_env_id: string; cwd: string }>(
    'SELECT isolation_env_id, cwd FROM remote_agent_conversations WHERE id = $1',
    [conversationId]
  );
  expect(rows[0]).toEqual({ isolation_env_id: container.id, cwd: container.working_path });
});

async function seedMissingPathContainer(): Promise<IsolationEnvironmentRow> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO remote_agent_isolation_environments
      (id, codebase_id, provider, workflow_type, workflow_id, working_path, branch_name)
     VALUES ($1, $2, 'container', 'task', $1, $3, '')`,
    [id, codebaseId, join(root, 'missing-host-folder')]
  );
  const row = await isolationDb.getById(id);
  if (!row) throw new Error('Container fixture missing');
  return row;
}

/**
 * A worktree cleanup observes a registration, then retires it. These tests
 * re-register the same workflow between the two (an upsert keeps the row id), and
 * expect the replacement to stay active after the cleanup's retire write.
 */
describe('cleanup retires only the registration it observed', () => {
  const reRegister = (): Promise<IsolationEnvironmentRow> =>
    isolationDb.create({
      codebase_id: env.codebase_id,
      workflow_type: env.workflow_type,
      workflow_id: env.workflow_id,
      working_path: env.working_path,
      branch_name: toBranchName(env.branch_name),
      metadata: env.metadata,
    });

  /** Re-register at the claim or retirement boundary, using real conditional writes. */
  function racingStore(): {
    store: IIsolationStore;
    afterRetire: () => IsolationEnvironmentRow | null | undefined;
    replacement: () => IsolationEnvironmentRow | undefined;
  } {
    const real = isolationDb.createIsolationStore();
    let replacement: IsolationEnvironmentRow | undefined;
    let after: IsolationEnvironmentRow | null | undefined;
    const race = async (write: () => Promise<void>): Promise<void> => {
      if (replacement) return write();
      replacement = await reRegister();
      try {
        await write();
      } finally {
        after = await isolationDb.getById(replacement.id);
      }
    };
    return {
      store: {
        ...real,
        withWorktreeRegistration: async (observed, remove) => {
          if (!replacement) replacement = await reRegister();
          try {
            return await real.withWorktreeRegistration(observed, remove);
          } finally {
            after = await isolationDb.getById(replacement.id);
          }
        },
        updateStatus: (id, next) =>
          next === 'destroyed'
            ? race(() => real.updateStatus(id, next))
            : real.updateStatus(id, next),
        markWorktreeDestroyed: observed => race(() => real.markWorktreeDestroyed(observed)),
      },
      afterRetire: () => after,
      replacement: () => replacement,
    };
  }

  function expectReplacementActive(
    after: IsolationEnvironmentRow | null | undefined,
    replacement: IsolationEnvironmentRow | undefined
  ): void {
    expect(replacement?.id).toBe(env.id);
    expect(after?.status).toBe('active');
    expect(after?.metadata.worktree_registration_id).toBe(
      replacement?.metadata.worktree_registration_id
    );
  }

  test('listing reconciles only the observed missing registration', async () => {
    await git(repo, 'worktree', 'remove', '--force', env.working_path);
    const { listEnvironments } = await import('../operations/isolation-operations');
    const mark = isolationDb.markWorktreeDestroyed;
    const update = isolationDb.updateStatus;
    let replacement: IsolationEnvironmentRow | undefined;
    const racingMark = spyOn(isolationDb, 'markWorktreeDestroyed').mockImplementation(
      async observed => {
        if (observed.id === env.id) replacement = await reRegister();
        await mark(observed);
      }
    );
    const racingUpdate = spyOn(isolationDb, 'updateStatus').mockImplementation(async (id, next) => {
      if (id === env.id && next === 'destroyed') replacement = await reRegister();
      await update(id, next);
    });
    try {
      await listEnvironments();
    } finally {
      racingMark.mockRestore();
      racingUpdate.mockRestore();
    }
    expectReplacementActive(await isolationDb.getById(env.id), replacement);
  });

  test.each([false, true])('refuses post-reload replacement with force=%s', async force => {
    const getCodebase = codebaseDb.getCodebase;
    let replacement: IsolationEnvironmentRow | undefined;
    const racing = spyOn(codebaseDb, 'getCodebase').mockImplementation(async id => {
      replacement = await reRegister();
      return getCodebase(id);
    });
    try {
      await expect(removeEnvironment(env, { force })).rejects.toBeInstanceOf(
        WorktreeRegistrationChangedError
      );
    } finally {
      racing.mockRestore();
    }
    expectReplacementActive(await isolationDb.getById(env.id), replacement);
    expect(existsSync(env.working_path)).toBe(true);
    expect(await git(repo, 'branch', '--list', env.branch_name)).not.toBe('');
  });

  test('conversation close refuses a registration replaced after selection', async () => {
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations
      (id, platform_type, platform_conversation_id, codebase_id, isolation_env_id, cwd)
      VALUES ($1, 'github', $1, $2, $3, $4)`,
      [conversationId, codebaseId, env.id, env.working_path]
    );
    const readLiveRun = isolationDb.getLiveRunOwningEnv;
    let replacement: IsolationEnvironmentRow | undefined;
    const racing = spyOn(isolationDb, 'getLiveRunOwningEnv').mockImplementation(async (...args) => {
      replacement ??= await reRegister();
      return readLiveRun(...args);
    });
    const destroy = spyOn(getIsolationProvider(), 'destroy');
    try {
      await expect(onConversationClosed('github', conversationId)).rejects.toThrow(
        'changed during cleanup'
      );
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      racing.mockRestore();
      destroy.mockRestore();
    }
    expectReplacementActive(await isolationDb.getById(env.id), replacement);
    expect(existsSync(env.working_path)).toBe(true);
    expect(await git(repo, 'branch', '--list', env.branch_name)).not.toBe('');
    const { rows } = await db.query<{ isolation_env_id: string; cwd: string }>(
      'SELECT isolation_env_id, cwd FROM remote_agent_conversations WHERE id = $1',
      [conversationId]
    );
    expect(rows[0]).toEqual({ isolation_env_id: env.id, cwd: env.working_path });
  });

  test('scheduled missing-path cleanup refuses a registration replaced after selection', async () => {
    await git(repo, 'worktree', 'remove', env.working_path);
    const getLiveRun = isolationDb.getLiveRunOwningEnv;
    let replacement: IsolationEnvironmentRow | undefined;
    const racing = spyOn(isolationDb, 'getLiveRunOwningEnv').mockImplementation(async id => {
      replacement = await reRegister();
      return getLiveRun(id);
    });
    const destroy = spyOn(getIsolationProvider(), 'destroy');
    try {
      const report = await runScheduledCleanup();
      expect(report.removed).toEqual([]);
      expect(report.errors).toContainEqual({
        id: env.id,
        error: expect.stringContaining('changed during cleanup'),
      });
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      racing.mockRestore();
      destroy.mockRestore();
    }
    expectReplacementActive(await isolationDb.getById(env.id), replacement);
    expect(await git(repo, 'branch', '--list', env.branch_name)).not.toBe('');
  });

  test('registration replacement waits until the destructive callback releases ownership', async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const destroy = spyOn(getIsolationProvider(), 'destroy').mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
      return {
        worktreeRemoved: false,
        directoryClean: false,
        branchDeleted: null,
        remoteBranchDeleted: null,
        warnings: [],
      };
    });
    const removal = removeEnvironment(env);
    await entered.promise;
    let published = false;
    const replacement = reRegister().then(row => {
      published = true;
      return row;
    });
    try {
      await Bun.sleep(0);
      expect(published).toBe(false);
    } finally {
      finish.resolve();
      await removal;
      await replacement;
      destroy.mockRestore();
    }
    expectReplacementActive(await isolationDb.getById(env.id), await replacement);
    expect(existsSync(env.working_path)).toBe(true);
  });

  test('run reclaim of a vanished checkout', async () => {
    await git(repo, 'worktree', 'remove', '--force', env.working_path);
    const { store: racing, afterRetire, replacement } = racingStore();
    await expect(reclaimRunWorktree(run, racing)).rejects.toThrow('changed during cleanup');
    expectReplacementActive(afterRetire(), replacement());
  });

  test('guarded run reclaim keeps the checkout', async () => {
    const { store: racing, afterRetire, replacement } = racingStore();
    const destroy = spyOn(getIsolationProvider(), 'destroy');
    try {
      await expect(reclaimRunWorktree(run, racing)).rejects.toThrow('changed during cleanup');
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      destroy.mockRestore();
    }
    expectReplacementActive(afterRetire(), replacement());
    expect(existsSync(env.working_path)).toBe(true);
    expect(await git(repo, 'branch', '--list', env.branch_name)).not.toBe('');
  });

  for (const lookup of ['existing', 'workflow', 'linked'] as const) {
    test(`resolver ${lookup} lookup of a vanished checkout`, async () => {
      if (lookup === 'linked') {
        env = await isolationDb.create({
          ...env,
          workflow_type: 'issue',
          workflow_id: '42',
          branch_name: toBranchName(env.branch_name),
          created_by_platform: undefined,
          created_by_user_id: undefined,
        });
      }
      await git(repo, 'worktree', 'remove', '--force', env.working_path);
      const { store: racing, afterRetire, replacement } = racingStore();
      const resolver = new IsolationResolver({ store: racing, provider: getIsolationProvider() });
      await expect(
        resolver.resolve({
          existingEnvId: lookup === 'existing' ? env.id : null,
          codebase: { id: codebaseId, name: 'test/repo', defaultCwd: repo },
          hints:
            lookup === 'linked'
              ? { workflowType: 'task', workflowId: 'linking', linkedIssues: [42] }
              : { workflowType: env.workflow_type, workflowId: env.workflow_id },
          platformType: 'cli',
        })
      ).rejects.toBeInstanceOf(WorktreeRegistrationChangedError);
      expectReplacementActive(afterRetire(), replacement());
      expect(await isolationDb.getById(env.id)).toEqual(replacement() ?? null);
    });
  }

  test('resolver release of an unlinked creation', async () => {
    const { store: racing, afterRetire, replacement } = racingStore();
    const resolver = new IsolationResolver({ store: racing, provider: getIsolationProvider() });
    const created = await resolver.resolve({
      existingEnvId: null,
      codebase: { id: codebaseId, name: 'test/repo', defaultCwd: repo },
      hints: { workflowType: 'task', workflowId: 'unlinked' },
      platformType: 'cli',
    });
    if (created.status !== 'resolved') throw new Error('Expected creation');
    env = created.env;
    const destroy = spyOn(getIsolationProvider(), 'destroy');
    try {
      await resolver.releaseUnlinked(created);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      destroy.mockRestore();
    }
    expectReplacementActive(afterRetire(), replacement());
    expect(existsSync(env.working_path)).toBe(true);
    expect(await git(repo, 'branch', '--list', env.branch_name)).not.toBe('');
  });
});
