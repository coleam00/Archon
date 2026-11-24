// @archon-test-isolated
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toBranchName, toRepoPath } from '@archon/git';
import { configureIsolation, getIsolationProvider } from '@archon/isolation';
import { setLogLevel } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { clearConfigCache } from '../config/config-loader';
import { configureWorktreeIsolation } from './worktree-setup';

setLogLevel('silent');

const track = trackTempRoots();
const originalEnv = {
  ARCHON_HOME: process.env.ARCHON_HOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
};
let root: string;
let repo: string;

function git(...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

beforeEach(async () => {
  root = track(await realpath(await mkdtemp(join(tmpdir(), 'archon-worktree-config-'))));
  process.env.ARCHON_HOME = join(root, 'home');
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
  clearConfigCache();
  await mkdir(process.env.ARCHON_HOME);
  await writeFile(
    join(process.env.ARCHON_HOME, 'config.yaml'),
    'worktree:\n  linkFiles: [.cache]\n'
  );
  repo = join(root, 'repo');
  await mkdir(repo);
  git('init', '-q', '-b', 'dev');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, '.gitignore'), '.cache\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'seed');
  configureWorktreeIsolation();
});

afterEach(() => {
  configureIsolation(async () => null);
  clearConfigCache();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function createWorktree(): Promise<string> {
  const created = await getIsolationProvider().create({
    codebaseId: 'cb-link',
    codebaseName: 'test/repo',
    canonicalRepoPath: toRepoPath(repo),
    workflowType: 'task',
    identifier: 'link',
    taskBranch: { kind: 'new', branch: toBranchName('link'), fromBranch: toBranchName('dev') },
  });
  return created.workingPath;
}

// Windows refuses linkFiles; the isolation package tests the refusal.
test.skipIf(process.platform === 'win32')(
  'global worktree.linkFiles links a project that sets none',
  async () => {
    const worktree = await createWorktree();
    expect((await lstat(join(worktree, '.cache'))).isSymbolicLink()).toBe(true);
    expect(await realpath(join(worktree, '.cache'))).toBe(join(repo, '.cache'));
  }
);

test("a project's own worktree.linkFiles replaces the global list", async () => {
  await mkdir(join(repo, '.archon'));
  await writeFile(join(repo, '.archon', 'config.yaml'), 'worktree:\n  linkFiles: []\n');
  const worktree = await createWorktree();
  expect(existsSync(join(worktree, '.cache'))).toBe(false);
});
