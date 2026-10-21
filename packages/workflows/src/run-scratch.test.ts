import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
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

  await releaseRunScratch({ id, output_root: root, metadata: ownedBy(process.pid) });

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
    metadata: { ...ownedBy(process.pid), isolation: 'container' },
  });

  expect(existsSync(checkout)).toBe(true);
});

test('scratch is kept while a process on this host may still execute the run', async () => {
  const { id, root, artifactsDir } = runStorage();
  const checkout = join(getRunScratchDir(artifactsDir), 'bisect', '.git');
  await mkdir(checkout, { recursive: true });

  await releaseRunScratch({ id, output_root: root, metadata: ownedBy(process.ppid) });

  expect(existsSync(checkout)).toBe(true);
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
