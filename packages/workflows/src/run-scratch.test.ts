import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { execFileAsync } from '@archon/git';
import {
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  getRunScratchDir,
  RUN_ARTIFACTS_ENGINE_SUBDIR,
} from '@archon/paths/archon-paths';
import { captureLogLines, trackTempRoots } from '@archon/paths/test-utils';
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

test('retains untagged evidence when releasing scratch', async () => {
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
  const cache = join(artifactsDir, 'cache');
  await tagged(cache);

  await releaseRunScratch({
    id,
    output_root: root,
    working_path: null,
    metadata: { ...ownedBy(process.pid), isolation: 'container' },
  });

  expect(existsSync(checkout)).toBe(true);
  expect(existsSync(cache)).toBe(true);
});

test('scratch is kept while a process on this host may still execute the run', async () => {
  const { id, root, artifactsDir } = runStorage();
  const checkout = join(getRunScratchDir(artifactsDir), 'bisect', '.git');
  await mkdir(checkout, { recursive: true });
  const cache = join(artifactsDir, 'cache');
  await tagged(cache);

  await releaseRunScratch({
    id,
    output_root: root,
    working_path: null,
    metadata: ownedBy(process.ppid),
  });

  expect(existsSync(checkout)).toBe(true);
  expect(existsSync(cache)).toBe(true);
});

test.each(['real', 'root-link', 'engine-link', 'scratch-link'] as const)(
  'deregisters only real in-tree scratch worktrees (%s)',
  async boundary => {
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
    const outside = join(base, 'outside');
    const actualScratch =
      boundary === 'real'
        ? scratch
        : boundary === 'root-link'
          ? getRunScratchDir(outside)
          : boundary === 'engine-link'
            ? join(outside, 'scratch')
            : outside;
    await mkdir(actualScratch, { recursive: true });
    if (boundary !== 'real') {
      const linkPath =
        boundary === 'root-link'
          ? artifactsDir
          : boundary === 'engine-link'
            ? join(artifactsDir, '.archon')
            : scratch;
      await mkdir(join(linkPath, '..'), { recursive: true });
      await symlink(outside, linkPath, 'junction');
    }
    const inScratch = join(actualScratch, 'lens', 'tree');
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

    expect(existsSync(inScratch)).toBe(boundary !== 'real');
    const { stdout } = await git('worktree', 'list', '--porcelain');
    // Git prints forward slashes on Windows; `resolve` returns the platform's spelling.
    const listed = stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => resolve(line.slice('worktree '.length).trim()));
    expect(listed.sort()).toEqual(
      (boundary === 'real'
        ? [resolve(repo), resolve(sibling)]
        : [resolve(repo), resolve(sibling), resolve(inScratch)]
      ).sort()
    );
    expect(existsSync(join(sibling, '.git'))).toBe(true);
  }
);

test.each(['inside', 'worktree', 'ancestor', 'scratch', 'engine'] as const)(
  'accounts for tagged %s caches before Git removes a scratch worktree',
  async placement => {
    const { id, root, artifactsDir } = runStorage();
    const repo = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'cache-worktree-'))));
    const git = (...args: string[]): Promise<{ stdout: string }> =>
      execFileAsync('git', ['-C', repo, ...args]);
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
    const worktree = join(scratch, 'probe', 'tree');
    await git('worktree', 'add', '-q', '--detach', worktree);
    const cache =
      placement === 'inside'
        ? join(worktree, 'cache')
        : placement === 'worktree'
          ? worktree
          : placement === 'ancestor'
            ? join(scratch, 'probe')
            : placement === 'scratch'
              ? scratch
              : join(artifactsDir, '.archon');
    await tagged(cache);
    const bulk = join(placement === 'inside' ? cache : worktree, 'bulk');
    await writeFile(bulk, Buffer.alloc(1024 * 1024, 1));
    const allocatedBulk = (await lstat(bulk)).blocks * 512;
    expect(allocatedBulk).toBeGreaterThan(0);
    await writeFile(join(artifactsDir, 'report.md'), 'evidence');
    const capture = captureLogLines();
    try {
      await releaseRunScratch({
        id,
        output_root: root,
        working_path: repo,
        metadata: ownedBy(process.pid),
      });
      const removals = capture.lines.filter(line => line.msg === 'run_scratch.cache_removed');
      expect(removals).toHaveLength(1);
      expect(removals[0]).toMatchObject({
        workflowRunId: id,
        artifactsDir,
        path: relative(artifactsDir, cache),
      });
      expect(Number(removals[0].estimatedFreedBytes)).toBeGreaterThanOrEqual(allocatedBulk);
    } finally {
      capture.restore();
    }
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(join(artifactsDir, 'report.md'))).toBe(true);
    const { stdout } = await git('worktree', 'list', '--porcelain', '-z');
    expect(stdout.split('\0').filter(field => field.startsWith('worktree '))).toHaveLength(1);
  }
);

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

const signature = 'Signature: 8a477f597d28d172789f06886806bc55';

async function tagged(path: string, content = signature): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'CACHEDIR.TAG'), content);
}

test('removes outermost tagged descendants, preserving the root and untagged evidence', async () => {
  const { artifactsDir } = runStorage();
  await tagged(artifactsDir);
  await writeFile(join(artifactsDir, 'report.md'), 'private evidence sentinel');
  const cache = join(artifactsDir, 'spike', 'arbitrary');
  await tagged(cache, signature + 'suffix without newline');
  await tagged(join(cache, 'nested'));
  await writeFile(join(cache, 'bulk'), Buffer.alloc(8192));
  await link(join(cache, 'bulk'), join(cache, 'bulk-link'));
  const allocation = await Promise.all(
    ['', 'CACHEDIR.TAG', 'nested', 'nested/CACHEDIR.TAG', 'bulk'].map(p => lstat(join(cache, p)))
  );
  const estimatedFreedBytes = allocation.reduce((sum, stat) => sum + stat.blocks * 512, 0);
  await tagged(join(artifactsDir, '.hidden', 'cache'));
  await tagged(join(artifactsDir, '.archon', 'cache'));
  await writeFile(join(artifactsDir, '.archon', 'listing.json'), '{}');
  await tagged(join(artifactsDir, 'invalid'), 'invalid');
  await tagged(join(artifactsDir, 'invalid', 'valid-child'));
  const capture = captureLogLines();
  try {
    await removeRunScratch(artifactsDir, { workflowRunId: 'fixture-run' });
    const removals = capture.lines.filter(line => line.msg === 'run_scratch.cache_removed');
    expect(removals).toHaveLength(4);
    expect(removals.find(line => line.path === join('spike', 'arbitrary'))).toMatchObject({
      workflowRunId: 'fixture-run',
      artifactsDir,
      estimatedFreedBytes,
    });
    expect(JSON.stringify(capture.lines)).not.toContain('private evidence sentinel');
  } finally {
    capture.restore();
  }
  for (const path of ['spike/arbitrary', '.hidden/cache', '.archon/cache', 'invalid/valid-child']) {
    expect(existsSync(join(artifactsDir, path))).toBe(false);
  }
  for (const path of [
    'CACHEDIR.TAG',
    'report.md',
    '.archon/listing.json',
    'invalid/CACHEDIR.TAG',
  ]) {
    expect(existsSync(join(artifactsDir, path))).toBe(true);
  }
  await removeRunScratch(artifactsDir, {});
});

test.each([
  '',
  'Signature:',
  signature.slice(0, -1),
  signature.toLowerCase(),
  ' ' + signature,
  '\ufeff' + signature,
])('ignores an invalid tag prefix %p', async content => {
  const { artifactsDir } = runStorage();
  const cache = join(artifactsDir, 'cache');
  await tagged(cache, content);
  await removeRunScratch(artifactsDir, {});
  expect(existsSync(join(cache, 'CACHEDIR.TAG'))).toBe(true);
});

test('a tag on the engine directory authorizes its entire subtree', async () => {
  const { artifactsDir } = runStorage();
  await tagged(join(artifactsDir, '.archon'));
  await mkdir(getRunScratchDir(artifactsDir));
  await writeFile(join(artifactsDir, 'report.md'), 'evidence');
  await removeRunScratch(artifactsDir, {});
  expect(existsSync(join(artifactsDir, '.archon'))).toBe(false);
  expect(existsSync(join(artifactsDir, 'report.md'))).toBe(true);
});

test('never follows directory or tag links, including links inside removed caches', async () => {
  const { artifactsDir } = runStorage();
  const outside = trackTempRoot(await mkdtemp(join(tmpdir(), 'cache-outside-')));
  await tagged(outside);
  await tagged(join(artifactsDir, 'cache'));
  await symlink(outside, join(artifactsDir, 'outside-link'), 'junction');
  await symlink(outside, join(artifactsDir, 'cache', 'outside-link'), 'junction');
  await symlink(join(artifactsDir, 'missing'), join(artifactsDir, 'dangling'), 'junction');
  await mkdir(join(artifactsDir, 'linked-tag'));
  await symlink(join(outside, 'CACHEDIR.TAG'), join(artifactsDir, 'linked-tag', 'CACHEDIR.TAG'));
  await mkdir(join(artifactsDir, 'directory-tag', 'CACHEDIR.TAG'), { recursive: true });
  await symlink(artifactsDir, join(artifactsDir, 'cycle'), 'junction');
  await removeRunScratch(artifactsDir, {});
  expect(existsSync(join(artifactsDir, 'cache'))).toBe(false);
  for (const path of [
    'outside-link',
    'linked-tag/CACHEDIR.TAG',
    'directory-tag/CACHEDIR.TAG',
    'cycle',
  ]) {
    expect(existsSync(join(artifactsDir, path))).toBe(true);
  }
  expect((await lstat(join(artifactsDir, 'dangling'))).isSymbolicLink()).toBe(true);
  expect(existsSync(join(outside, 'CACHEDIR.TAG'))).toBe(true);
});

test.each(['root', 'engine', 'scratch'] as const)(
  'does not escape through a %s link during release or direct removal',
  async boundary => {
    const { id, root, artifactsDir } = runStorage();
    const outside = trackTempRoot(await mkdtemp(join(tmpdir(), 'scratch-outside-')));
    const outsideScratch =
      boundary === 'root' ? getRunScratchDir(outside) : join(outside, 'scratch');
    await tagged(outsideScratch);
    const linkPath =
      boundary === 'root'
        ? artifactsDir
        : boundary === 'engine'
          ? join(artifactsDir, '.archon')
          : getRunScratchDir(artifactsDir);
    await mkdir(join(linkPath, '..'), { recursive: true });
    await symlink(outside, linkPath, 'junction');
    await releaseRunScratch({
      id,
      output_root: root,
      working_path: outside,
      metadata: ownedBy(process.pid),
    });
    await removeRunScratch(artifactsDir, { envId: 'fixture-container' });
    expect(existsSync(join(outsideScratch, 'CACHEDIR.TAG'))).toBe(true);
  }
);

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([0o500, 0o300])(
  'failed cache deletion (%i permissions) is logged, independent siblings and scratch still clean',
  async mode => {
    const { artifactsDir } = runStorage();
    const blocked = join(artifactsDir, 'blocked');
    await tagged(blocked);
    await mkdir(join(blocked, 'child'));
    await tagged(join(artifactsDir, 'independent'));
    await mkdir(getRunScratchDir(artifactsDir), { recursive: true });
    await chmod(blocked, mode);
    const capture = captureLogLines();
    try {
      await removeRunScratch(artifactsDir, { workflowRunId: 'blocked-run' });
      expect(existsSync(blocked)).toBe(true);
      if (mode === 0o300)
        expect(capture.lines.some(line => line.msg === 'run_scratch.cache_measure_failed')).toBe(
          true
        );
      expect(existsSync(join(artifactsDir, 'independent'))).toBe(false);
      expect(existsSync(getRunScratchDir(artifactsDir))).toBe(false);
      expect(
        capture.lines.some(
          line => line.msg === 'run_scratch.cache_remove_failed' && line.path === blocked
        )
      ).toBe(true);
      expect(
        capture.lines.some(
          line => line.msg === 'run_scratch.cache_removed' && line.path === 'blocked'
        )
      ).toBe(false);
    } finally {
      capture.restore();
      await chmod(blocked, 0o700);
    }
  }
);
