// @archon-test-isolated
/**
 * Real Git and a real SQLite database: abandonment removes the worktree a run
 * created, with force, and keeps its branch. Runs in its own `bun test`
 * invocation (declared by @archon-test-isolated) because it mock.module's the DB connection.
 */
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
import { WorktreeProvider, configureIsolation, getIsolationProvider } from '@archon/isolation';
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
const { claimPendingWorkflowRun } = await import('../db/workflows');
const { onConversationClosed, reclaimRunWorktree, removeEnvironment } =
  await import('./cleanup-service');

async function git(path: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', path, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
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
    if (initialStatus === 'destroyed') await removeEnvironment(env.id);

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
  root = track(await realpath(await mkdtemp(join(tmpdir(), 'archon-release-'))));
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
    metadata: { worktree_creation_id: created.metadata.creationId },
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
    metadata: { worktree_creation_id: created.metadata.creationId },
  });
  run.working_path = created.workingPath;
  run.metadata = { owned_worktree: { envId: env.id, creationId: created.metadata.creationId } };
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

  test('a removal that fails while still registered can be retried', async () => {
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
    expect(await status()).toBe('active');
    expect(await readWorktreeLock(gitModule.toWorktreePath(env.working_path))).toBeNull();

    await reclaimRunWorktree(run, store);
    expect(existsSync(env.working_path)).toBe(false);
    expect(await status()).toBe('destroyed');
  });

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
    // `run --detach --adopt` pre-creates its row with no working_path and claims it
    // before stamping the inherited checkout, so the claim must carry the path.
    const adopter = await seedRunAt(null, 'pending');
    const originalExec = gitModule.execFileAsync;
    let claimed: unknown;
    const exec = spyOn(gitModule, 'execFileAsync').mockImplementation(
      async (file, args, options) => {
        if (file === 'git' && args.includes('worktree') && args.includes('remove'))
          claimed = await claimPendingWorkflowRun(adopter, env.working_path);
        return originalExec(file, args, options);
      }
    );
    try {
      await reclaimRunWorktree(run, store);
    } finally {
      exec.mockRestore();
    }
    expect(claimed).toBeNull();
    expect(existsSync(env.working_path)).toBe(false);
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

  test('a run that reuses the checkout during removal can neither start nor adopt it', async () => {
    const originalExec = gitModule.execFileAsync;
    let lateRun: string | undefined;
    let claimed: unknown;
    let adoption: unknown;
    const exec = spyOn(gitModule, 'execFileAsync').mockImplementation(
      async (file, args, options) => {
        if (file === 'git' && args.includes('worktree') && args.includes('remove')) {
          // Past the final claimant check: the record still names this path, so a
          // concurrent start that read it earlier inserts its run now.
          lateRun = await seedRunAt(env.working_path, 'pending');
          claimed = await claimPendingWorkflowRun(lateRun);
          adoption = await provider.create(request()).catch((err: unknown) => err);
        }
        return originalExec(file, args, options);
      }
    );
    try {
      await reclaimRunWorktree(run, store);
    } finally {
      exec.mockRestore();
    }
    expect(claimed).toBeNull();
    expect(String(adoption)).toContain('an abandoned run is removing it');
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

  test('legacy and adopted runs retain checkout without manufacturing proof', async () => {
    run.metadata = {};
    expect(await reclaimRunWorktree(run, store)).toEqual({
      warnings: [expect.stringContaining('no valid proof')],
    });
    expect(existsSync(env.working_path)).toBe(true);
  });

  test.each(['record', 'marker', 'path'])(
    'mismatched %s refuses replacement estate',
    async kind => {
      if (kind === 'record')
        await isolationDb.updateMetadata(env.id, { worktree_creation_id: 'x' });
      if (kind === 'path') run.working_path = repo;
      if (kind === 'marker') {
        const { gitDir } = await getGitCheckoutIdentity(env.working_path);
        await writeFile(join(gitDir, 'archon-creation-id'), 'replacement');
      }
      await expect(reclaimRunWorktree(run, store)).rejects.toThrow(
        kind === 'marker' ? 'identity changed' : 'proof'
      );
      expect(existsSync(env.working_path)).toBe(true);
      expect(await status()).toBe('active');
    }
  );

  test('a record write failure before removal keeps the checkout', async () => {
    store = {
      ...store,
      updateStatus: async () => {
        throw new Error('record write failed');
      },
    };
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow('record write failed');
    expect(existsSync(env.working_path)).toBe(true);
    expect(await status()).toBe('active');
  });

  test('a vanished but registered detached checkout is retained, not falsely finalized', async () => {
    await git(env.working_path, 'checkout', '--detach', '-q');
    await rm(env.working_path, { recursive: true });
    await expect(reclaimRunWorktree(run, store)).rejects.toThrow('still registered');
    expect(await status()).toBe('active');
  });

  test.each(['worktreeRemoved', 'directoryClean'] as const)(
    'incomplete provider %s result keeps the record active',
    async field => {
      const destroy = spyOn(getIsolationProvider(), 'destroy').mockImplementation(
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
        destroy.mockRestore();
      }
    }
  );

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

test('ordinary cleanup preserves a replacement clone and its active record', async () => {
  await git(repo, 'worktree', 'remove', env.working_path);
  await git(root, 'clone', '-q', repo, env.working_path);
  await writeFile(join(env.working_path, 'operator-file'), 'keep me');

  const error = await removeEnvironment(env.id, { force: true }).catch((error: unknown) => error);

  expect(await readFile(join(env.working_path, 'operator-file'), 'utf8')).toBe('keep me');
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain('ownership');
  expect(await status()).toBe('active');
  expect(await git(repo, 'branch', '--list', env.branch_name)).toContain(env.branch_name);
});

test('ordinary cleanup removes a proven checkout and its branch', async () => {
  const result = await removeEnvironment(env.id);
  expect(result.worktreeRemoved).toBe(true);
  expect(result.branchDeleted).toBe(true);
  expect(existsSync(env.working_path)).toBe(false);
  expect(await status()).toBe('destroyed');
  expect(await git(repo, 'branch', '--list', env.branch_name)).toBe('');
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
  await expect(removeEnvironment(env.id, { force: true })).rejects.toThrow('ownership');
  expect(await readFile(join(env.working_path, 'operator-file'), 'utf8')).toBe('keep me');
});

test('ordinary cleanup removes a proven checkout under a symlinked base', async () => {
  await useSymlinkedBase();
  const result = await removeEnvironment(env.id);
  expect(result.worktreeRemoved).toBe(true);
  expect(existsSync(env.working_path)).toBe(false);
  expect(await status()).toBe('destroyed');
});
