import * as gitModule from '@archon/git';
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { getGitCheckoutIdentity, toRepoPath, toBranchName } from '@archon/git';
import { WorktreeProvider, configureIsolation, getIsolationProvider } from '@archon/isolation';
import type { IsolationEnvironmentRow, IIsolationStore } from '@archon/isolation';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { setLogLevel } from '@archon/paths';

setLogLevel('silent');
let repo: string;
let claim: { id: string; status: string } | null = null;
const getClaim = mock(async () => claim);
mock.module('../db/isolation-environments', () => ({ getLiveRunOwningEnv: getClaim }));
mock.module('../db/codebases', () => ({ getCodebase: async () => ({ default_cwd: repo }) }));
const configLoader = await import('../config/config-loader');
mock.module('../config/config-loader', () => ({
  ...configLoader,
  loadRepoConfig: async () => ({ worktree: { remote: 'upstream' } }),
}));
const { reclaimRunWorktree } = await import('./cleanup-service');

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

const track = trackTempRoots();
let root: string;
let env: IsolationEnvironmentRow;
let run: WorkflowRun;
let store: IIsolationStore;
let provider: WorktreeProvider;
beforeEach(async () => {
  root = track(await realpath(await mkdtemp(join(tmpdir(), 'archon-release-'))));
  repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, '.gitignore'), '*.secret\n');
  await writeFile(join(repo, 'file'), 'original');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'initial');
  const remote = join(root, 'remote.git');
  await mkdir(remote);
  await git(remote, 'init', '--bare', '-q');
  await git(repo, 'remote', 'add', 'upstream', remote);
  await git(repo, 'push', '-q', 'upstream', 'main');
  configureIsolation(async () => ({
    baseBranch: toBranchName('main'),
    remote: 'upstream',
    path: '.worktrees',
  }));
  provider = new WorktreeProvider(async () => ({
    baseBranch: toBranchName('main'),
    remote: 'upstream',
    path: '.worktrees',
  }));
  const created = await provider.create({
    canonicalRepoPath: toRepoPath(repo),
    codebaseId: 'cb',
    codebaseName: 'test/repo',
    workflowType: 'task',
    identifier: 'release',
  });
  if (created.metadata.adopted || !created.metadata.creationId)
    throw new Error('Expected fresh creation');
  env = {
    id: 'env',
    codebase_id: 'cb',
    workflow_type: 'task',
    workflow_id: 'release',
    provider: 'worktree',
    working_path: created.workingPath,
    branch_name: created.branchName,
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'cli',
    created_by_user_id: null,
    metadata: { worktree_creation_id: created.metadata.creationId },
  };
  run = {
    id: 'run',
    workflow_name: 'test',
    conversation_id: 'conv',
    parent_conversation_id: null,
    codebase_id: 'cb',
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
  };
  store = {
    getById: async () => env,
    updateStatus: async (_, status) => {
      env.status = status;
    },
    create: async () => env,
    findActiveByWorkflow: async () => env,
    countActiveByCodebase: async () => 1,
  };
  claim = null;
  getClaim.mockClear();
});

describe('owned worktree release', () => {
  test('clean pushed tree releases checkout and record, retaining branch; retry is idempotent', async () => {
    await reclaimRunWorktree(run, store, { phase: 'release' });
    expect(existsSync(env.working_path)).toBe(false);
    expect(env.status).toBe('destroyed');
    expect(await git(repo, 'rev-parse', '--verify', env.branch_name)).toBeTruthy();
    await expect(reclaimRunWorktree(run, store, { phase: 'release' })).resolves.toEqual([]);
  });

  test.each(['unstaged', 'staged', 'untracked', 'ignored'])(
    'retains %s work and the active row',
    async kind => {
      const file = join(
        env.working_path,
        kind === 'ignored' ? 'operator.secret' : kind === 'untracked' ? 'untracked' : 'file'
      );
      await writeFile(file, 'operator work');
      if (kind === 'staged') await git(env.working_path, 'add', 'file');
      await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
        'uncommitted, untracked, or ignored'
      );
      expect(await readFile(file, 'utf8')).toBe('operator work');
      expect(env.status).toBe('active');
    }
  );

  test('unpushed commits refuse even with no upstream; pushing allows detached HEAD release', async () => {
    await writeFile(join(env.working_path, 'file'), 'new commit');
    await git(env.working_path, 'add', 'file');
    await git(env.working_path, 'commit', '-qm', 'unpushed');
    await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
      'unpushed commits'
    );
    expect(env.status).toBe('active');
    await git(env.working_path, 'push', '-q', 'upstream', 'HEAD:refs/heads/published');
    await git(env.working_path, 'checkout', '--detach', '-q');
    await reclaimRunWorktree(run, store, { phase: 'release' });
    expect(env.status).toBe('destroyed');
  });

  test('deleted remote refs are refreshed rather than trusted', async () => {
    await git(repo, 'push', '-q', 'upstream', ':main');
    await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
      'unpushed commits'
    );
    expect(env.status).toBe('active');
  });

  test('unavailable remote refuses', async () => {
    await git(repo, 'remote', 'set-url', 'upstream', join(root, 'missing.git'));
    await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
      'Could not release worktree'
    );
    expect(env.status).toBe('active');
  });

  test('legacy and adopted runs retain checkout without manufacturing proof', async () => {
    run.metadata = {};
    expect(await reclaimRunWorktree(run, store, { phase: 'release' })).toEqual([
      expect.stringContaining('no valid proof'),
    ]);
    expect(existsSync(env.working_path)).toBe(true);
  });

  test.each(['record', 'marker', 'path'])(
    'mismatched %s refuses replacement estate',
    async kind => {
      if (kind === 'record') env.metadata.worktree_creation_id = 'replacement';
      if (kind === 'path') run.working_path = repo;
      if (kind === 'marker') {
        const { gitDir } = await getGitCheckoutIdentity(env.working_path);
        await writeFile(join(gitDir, 'archon-creation-id'), 'replacement');
      }
      await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
        kind === 'marker' ? 'identity' : 'proof'
      );
      expect(existsSync(env.working_path)).toBe(true);
      expect(env.status).toBe('active');
    }
  );

  test('another claimable user blocks release; preflight passes its explicit exclusions', async () => {
    claim = { id: 'other', status: 'failed' };
    await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
      'claimable run other'
    );
    claim = null;
    await reclaimRunWorktree(run, store, { phase: 'inspect', excludeRunIds: ['run'] });
    expect(getClaim).toHaveBeenLastCalledWith('env', ['run']);
    expect(env.status).toBe('active');
  });

  test('a database failure after removal is visible; retry finalizes proved absence', async () => {
    const update = store.updateStatus;
    store.updateStatus = async () => {
      throw new Error('record write failed');
    };
    await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
      'record write failed'
    );
    expect(existsSync(env.working_path)).toBe(false);
    expect(env.status).toBe('active');
    store.updateStatus = update;
    await reclaimRunWorktree(run, store, { phase: 'release' });
    expect(env.status).toBe('destroyed');
  });

  test('a vanished but registered detached checkout is retained, not falsely finalized', async () => {
    await git(env.working_path, 'checkout', '--detach', '-q');
    await rm(env.working_path, { recursive: true });
    await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
      'still registered'
    );
    expect(env.status).toBe('active');
  });

  test('provider rejects dirt, changed HEAD and marker at its destruction boundary', async () => {
    const proof = env.metadata.worktree_creation_id;
    if (typeof proof !== 'string') throw new Error('missing token');
    const head = await git(env.working_path, 'rev-parse', 'HEAD');
    const options = {
      canonicalRepoPath: toRepoPath(repo),
      guardedRemoval: { creationId: proof, head },
    };
    await writeFile(join(env.working_path, 'operator.secret'), 'preserve');
    await expect(provider.destroy(env.working_path, options)).rejects.toThrow('ignored');
    await rm(join(env.working_path, 'operator.secret'));
    await expect(
      provider.destroy(env.working_path, {
        ...options,
        guardedRemoval: { creationId: proof, head: 'old' },
      })
    ).rejects.toThrow('HEAD changed');
    await expect(
      provider.destroy(env.working_path, {
        ...options,
        guardedRemoval: { creationId: 'replacement', head },
      })
    ).rejects.toThrow('identity changed');
    expect(existsSync(env.working_path)).toBe(true);
  });
  test.each(['dirt', 'HEAD'])('a late %s change prevents removal', async kind => {
    getClaim.mockImplementationOnce(async () => null);
    getClaim.mockImplementationOnce(async () => {
      await writeFile(join(env.working_path, 'file'), 'late edit');
      if (kind === 'HEAD') {
        await git(env.working_path, 'add', 'file');
        await git(env.working_path, 'commit', '-qm', 'late commit');
      }
      return null;
    });
    await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
      kind === 'HEAD' ? 'HEAD changed' : 'uncommitted'
    );
    expect(existsSync(env.working_path)).toBe(true);
    expect(env.status).toBe('active');
  });

  test.each(['worktreeRemoved', 'directoryClean'] as const)(
    'incomplete provider %s result keeps the record active',
    async field => {
      const destroy = spyOn(getIsolationProvider(), 'destroy').mockResolvedValue({
        worktreeRemoved: true,
        directoryClean: true,
        branchDeleted: null,
        remoteBranchDeleted: null,
        warnings: [],
        [field]: false,
      });
      try {
        await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
          'filesystem removal incomplete'
        );
        expect(env.status).toBe('active');
      } finally {
        destroy.mockRestore();
      }
    }
  );
  test('a residual directory survives guarded removal and keeps the row active', async () => {
    const originalExec = gitModule.execFileAsync;
    const exec = spyOn(gitModule, 'execFileAsync').mockImplementation(
      async (file, args, options) => {
        const result = await originalExec(file, args, options);
        if (file === 'git' && args.includes('worktree') && args.includes('remove')) {
          await mkdir(env.working_path);
          await writeFile(join(env.working_path, 'operator.secret'), 'late residue');
        }
        return result;
      }
    );
    try {
      await expect(reclaimRunWorktree(run, store, { phase: 'release' })).rejects.toThrow(
        'filesystem removal incomplete'
      );
      expect(await readFile(join(env.working_path, 'operator.secret'), 'utf8')).toBe(
        'late residue'
      );
      expect(env.status).toBe('active');
    } finally {
      exec.mockRestore();
    }
  });
});
