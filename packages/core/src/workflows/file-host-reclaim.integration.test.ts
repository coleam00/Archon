// @archon-test-isolated
import { afterEach, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { setLogLevel } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { toBranchName, toRepoPath } from '@archon/git';
import { configureIsolation, WorktreeProvider } from '@archon/isolation';
import { setPlatformPolicies } from '../platforms/registry';

setLogLevel('silent');
const sqlOpen = mock(() => {
  throw new Error('SQL open trap');
});
const connection = await import('../db/connection');
mock.module('../db/connection', () => ({
  ...connection,
  getDatabase: sqlOpen,
  getDialect: sqlOpen,
  pool: { query: sqlOpen, connect: sqlOpen },
}));
const { createFileWorkflowHost } = await import('./file-host');
const roots = trackTempRoots();
const prior = { ...process.env };
afterEach(() => {
  process.env = { ...prior };
  sqlOpen.mockClear();
});
async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(error);
}

test.each(['none', 'path', 'proof', 'partial-proof', 'env', 'completed'] as const)(
  'file abandonment reclaims its own checkout and respects a %s claimant without SQL',
  async claimant => {
    setPlatformPolicies([]);
    const home = roots(await realpath(await mkdtemp(join(tmpdir(), 'file-reclaim-'))));
    process.env.ARCHON_HOME = home;
    process.env.DATABASE_URL = '';
    const repo = join(home, 'repo');
    await mkdir(repo);
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(repo, 'file'), 'initial');
    await git(repo, 'add', 'file');
    await git(repo, 'commit', '-qm', 'initial');
    const remote = join(home, 'remote.git');
    await mkdir(remote);
    await git(remote, 'init', '--bare', '-q');
    await git(repo, 'remote', 'add', 'origin', remote);
    await git(repo, 'push', '-q', 'origin', 'main');
    const config = async () => ({
      baseBranch: toBranchName('main'),
      remote: 'origin',
      path: '.worktrees',
    });
    configureIsolation(config);
    const host = await createFileWorkflowHost(join(home, 'store'));
    const codebase = await host.records.codebases.createCodebase({
      name: 'repo',
      default_cwd: repo,
    });
    const created = await new WorktreeProvider(config).create({
      canonicalRepoPath: toRepoPath(repo),
      codebaseId: codebase.id,
      codebaseName: 'repo',
      workflowType: 'task',
      identifier: 'release',
    });
    if (created.metadata.provenance !== 'created') throw new Error('Expected fresh creation');
    const env = await host.records.isolation.create({
      codebase_id: codebase.id,
      workflow_type: 'task',
      workflow_id: 'release',
      working_path: created.workingPath,
      branch_name: created.branchName,
      metadata: { worktree_creation_id: created.metadata.creationId },
    });
    const proof = { envId: env.id, creationId: created.metadata.creationId };
    const run = await host.deps.store.createWorkflowRun({
      workflow_name: 'release',
      user_message: '',
      codebase_id: codebase.id,
      working_path: created.workingPath,
      metadata: {
        owned_worktree: proof,
        execution_owner: { host: hostname(), pid: process.pid, uid: process.getuid?.() },
      },
    });
    await host.deps.store.claimPendingWorkflowRun(run.id);
    await host.deps.store.pauseWorkflowRun(run.id, {
      nodeId: 'review',
      pauseId: 'pause',
      message: 'Choose',
    });
    let other: string | undefined;
    if (claimant !== 'none') {
      const row = await host.deps.store.createWorkflowRun({
        workflow_name: 'other',
        user_message: '',
        codebase_id: codebase.id,
        working_path:
          claimant === 'path' || claimant === 'completed' ? created.workingPath : undefined,
        metadata:
          claimant === 'proof'
            ? { owned_worktree: proof }
            : claimant === 'partial-proof'
              ? { owned_worktree: { envId: env.id } }
              : claimant === 'env'
                ? { isolation_env_id: env.id }
                : {},
      });
      other = row.id;
      if (claimant === 'proof') await host.deps.store.failWorkflowRun(row.id, 'failure');
      if (claimant === 'env') await host.deps.store.updateWorkflowRun(row.id, { status: 'paused' });
      if (claimant === 'completed') await host.deps.store.claimPendingWorkflowRun(row.id);
      if (claimant === 'completed')
        await host.deps.store.completeWorkflowRun(row.id, { duration_ms: 1 });
    }
    const result = await host.operations.abandonWorkflow(run.id, { kind: 'operator' });
    if (claimant === 'none' || claimant === 'completed') {
      expect(result.releasedWorktrees, JSON.stringify(result)).toHaveLength(1);
      expect(result.cleanupWarnings ?? []).toEqual([]);
      expect(existsSync(created.workingPath)).toBe(false);
      expect((await host.records.isolation.getById(env.id))?.status).toBe('destroyed');
      await git(repo, 'rev-parse', '--verify', created.branchName);
    } else {
      expect(result.releasedWorktrees ?? []).toHaveLength(0);
      expect(result.cleanupWarnings?.join('\n')).toContain(`claimable run ${other}`);
      expect(existsSync(created.workingPath)).toBe(true);
      expect((await host.records.isolation.getById(env.id))?.status).toBe('active');
    }
    expect(sqlOpen).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'archon.db'))).toBe(false);
  },
  30000
);
