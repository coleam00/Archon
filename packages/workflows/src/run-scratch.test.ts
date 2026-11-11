import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileAsync } from '@archon/git';
import {
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  getRunScratchDir,
  RUN_ARTIFACTS_ENGINE_SUBDIR,
} from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  enterRunExecution,
  noExecutorCanWrite,
  releaseRunScratch,
  removeRunScratch,
} from './run-scratch';

const trackTempRoot = trackTempRoots();

function ownedBy(pid: number, host = hostname()): Record<string, unknown> {
  return { execution_owner: { host, pid } };
}

function runStorage(): { id: string; root: string; artifactsDir: string } {
  const id = crypto.randomUUID();
  const root = trackTempRoot(join(getArchonWorkspacesPath(), '_cwd', `run-scratch-${id}`));
  return { id, root, artifactsDir: getRunArtifactsDirForRoot(root, id) };
}

test('removes only the scratch child of the run', async () => {
  const { id, root, artifactsDir } = runStorage();
  const checkout = join(getRunScratchDir(artifactsDir), 'bisect', 'node_modules', 'pkg');
  await mkdir(checkout, { recursive: true });
  await writeFile(join(artifactsDir, 'report.md'), 'evidence');

  await releaseRunScratch({
    id,
    output_root: root,
    working_path: null,
    metadata: ownedBy(process.pid),
  });

  expect(existsSync(getRunScratchDir(artifactsDir))).toBe(false);
  expect(existsSync(join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR))).toBe(true);
  expect(existsSync(join(artifactsDir, 'report.md'))).toBe(true);
});

test("a container run's scratch is left for its container teardown", async () => {
  const { id, root, artifactsDir } = runStorage();
  const checkout = join(getRunScratchDir(artifactsDir), 'bisect', '.git');
  await mkdir(checkout, { recursive: true });

  await releaseRunScratch({
    id,
    output_root: root,
    working_path: null,
    metadata: { ...ownedBy(process.pid), isolation: 'container' },
  });

  expect(existsSync(checkout)).toBe(true);
});

test('scratch is kept while a process on this host may still execute the run', async () => {
  const { id, root, artifactsDir } = runStorage();
  const checkout = join(getRunScratchDir(artifactsDir), 'bisect', '.git');
  await mkdir(checkout, { recursive: true });

  await releaseRunScratch({
    id,
    output_root: root,
    working_path: null,
    metadata: ownedBy(process.ppid),
  });

  expect(existsSync(checkout)).toBe(true);
});

test("deregisters the worktrees a node added under scratch from the run's repository", async () => {
  const { id, root, artifactsDir } = runStorage();
  const base = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'run-scratch-repo-'))));
  const repo = join(base, 'repo');
  const git = (...args: string[]): Promise<{ stdout: string }> =>
    execFileAsync('git', ['-C', repo, ...args]);
  await mkdir(repo);
  await git('init', '-q');
  await git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  );
  const scratch = getRunScratchDir(artifactsDir);
  await mkdir(scratch, { recursive: true });
  const inScratch = join(scratch, 'lens', 'tree');
  const sibling = join(base, 'sibling');
  await git('worktree', 'add', '-q', '--detach', inScratch);
  await git('worktree', 'add', '-q', '--detach', sibling);
  // Uncommitted work never keeps a scratch worktree registered.
  await writeFile(join(inScratch, 'dirty.txt'), 'tried a mutation');

  await releaseRunScratch({
    id,
    output_root: root,
    working_path: repo,
    metadata: ownedBy(process.pid),
  });

  expect(existsSync(scratch)).toBe(false);
  const { stdout } = await git('worktree', 'list', '--porcelain');
  // Git prints forward slashes on Windows; `resolve` returns the platform's spelling.
  const listed = stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => resolve(line.slice('worktree '.length).trim()));
  expect(listed).toEqual([resolve(repo), resolve(sibling)]);
  expect(existsSync(join(sibling, '.git'))).toBe(true);
});

describe('noExecutorCanWrite', () => {
  // Above every platform's pid range, so no process holds it.
  const exited = 2 ** 31 - 1;

  test.each([
    ['this process, not executing it', ownedBy(process.pid), true],
    ['an exited process on this host', ownedBy(exited), true],
    ['a live process on this host', ownedBy(process.ppid), false],
    ['a process on another host', ownedBy(exited, 'other-host'), false],
    ['not recorded', {}, false],
  ] as const)('an owner that is %s: %p', (_case, metadata, proven) => {
    expect(noExecutorCanWrite({ id: crypto.randomUUID(), metadata })).toBe(proven);
  });

  test('this process holds a run until every execution of it has left', () => {
    const run = { id: crypto.randomUUID(), metadata: ownedBy(process.pid) };
    const outer = enterRunExecution(run.id);
    const inner = enterRunExecution(run.id);
    inner();
    expect(noExecutorCanWrite(run)).toBe(false);
    outer();
    expect(noExecutorCanWrite(run)).toBe(true);
  });
});

// The terminal status write is authoritative, so a scratch entry that cannot be deleted
// must not fail the executor exit, an operator's cancel or a container teardown.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a removal that fails resolves instead of throwing',
  async () => {
    const { artifactsDir } = runStorage();
    const locked = join(getRunScratchDir(artifactsDir), 'locked');
    await mkdir(join(locked, 'checkout'), { recursive: true });
    await chmod(locked, 0o500);
    try {
      await removeRunScratch(artifactsDir, {});
      expect(existsSync(join(locked, 'checkout'))).toBe(true);
    } finally {
      await chmod(locked, 0o700);
    }
  }
);
