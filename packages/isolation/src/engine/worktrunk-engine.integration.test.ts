/**
 * Integration test for `WorktrunkEngine` against the real `wt` binary and a real
 * git repository. Skipped (not failed) when `wt` isn't on PATH — the unit tests
 * in `worktrunk-engine.test.ts` cover the same logic against a mocked
 * subprocess and always run.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toRepoPath, toBranchName, toWorktreePath } from '@archon/git';
import { WorktrunkEngine } from './worktrunk-engine';

const hasWt = (() => {
  try {
    execFileSync('wt', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasWt)('WorktrunkEngine (integration, real wt + git)', () => {
  let tmpRoot: string;
  let repoPath: string;
  let worktreeDest: string;
  let originalWorktrunkConfigPath: string | undefined;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'archon-wt-engine-'));
    repoPath = join(tmpRoot, 'repo');
    worktreeDest = join(tmpRoot, 'dest');
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    execFileSync('git', ['-C', repoPath, 'commit', '-q', '--allow-empty', '-m', 'init']);

    // Point at an empty user config so this test is hermetic: it must not
    // depend on (or be broken by) whatever hooks the machine running it has
    // configured globally for worktrunk (e.g. a pre-start hook that creates
    // untracked files, which would make a later --no-delete-branch removal
    // fail on "uncommitted changes").
    const emptyConfigPath = join(tmpRoot, 'empty-wt-config.toml');
    writeFileSync(emptyConfigPath, '');
    originalWorktrunkConfigPath = process.env.WORKTRUNK_CONFIG_PATH;
    process.env.WORKTRUNK_CONFIG_PATH = emptyConfigPath;
  });

  afterAll(() => {
    if (originalWorktrunkConfigPath === undefined) {
      delete process.env.WORKTRUNK_CONFIG_PATH;
    } else {
      process.env.WORKTRUNK_CONFIG_PATH = originalWorktrunkConfigPath;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('add() creates a real worktree at the pinned destination', async () => {
    const engine = new WorktrunkEngine();
    const worktreePath = join(worktreeDest, 'feature-x');

    await engine.add({
      repoPath: toRepoPath(repoPath),
      worktreePath: toWorktreePath(worktreePath),
      branch: toBranchName('feature-x'),
      startPoint: 'main',
    });

    const gitFile = execFileSync('cat', [join(worktreePath, '.git')]).toString();
    expect(gitFile).toContain('gitdir:');
  });

  test('list() reports the created worktree', async () => {
    const engine = new WorktrunkEngine();

    const worktrees = await engine.list(toRepoPath(repoPath));

    const branchNames = worktrees.map(w => w.branch);
    expect(branchNames).toContain('feature-x');
  });

  test('remove() removes the worktree and leaves the branch (--no-delete-branch)', async () => {
    const engine = new WorktrunkEngine();
    const worktreePath = join(worktreeDest, 'feature-x');

    await engine.remove({
      repoPath: toRepoPath(repoPath),
      worktreePath: toWorktreePath(worktreePath),
    });

    const worktrees = await engine.list(toRepoPath(repoPath));
    expect(worktrees.map(w => w.branch)).not.toContain('feature-x');

    const branches = execFileSync('git', ['-C', repoPath, 'branch', '--list', 'feature-x'])
      .toString()
      .trim();
    expect(branches).toContain('feature-x');
  });

  test('prune() runs cleanly against the real repo', async () => {
    const engine = new WorktrunkEngine();
    await expect(engine.prune(toRepoPath(repoPath))).resolves.toBeUndefined();
  });
});
