import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  getRunScratchDir,
  RUN_ARTIFACTS_ENGINE_SUBDIR,
} from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { releaseRunScratch, removeRunScratch } from './run-scratch';

const trackTempRoot = trackTempRoots();
const posix = process.platform !== 'win32';

function runStorage(): { id: string; root: string; artifactsDir: string } {
  const id = crypto.randomUUID();
  const root = trackTempRoot(join(getArchonWorkspacesPath(), '_cwd', `run-scratch-${id}`));
  return { id, root, artifactsDir: getRunArtifactsDirForRoot(root, id) };
}

/** A directory outside the run holding a `scratch` child with a file that must survive. */
async function outsideScratch(): Promise<{ outside: string; kept: string }> {
  const outside = trackTempRoot(await mkdtemp(join(tmpdir(), 'run-scratch-outside-')));
  await mkdir(join(outside, 'scratch'));
  await writeFile(join(outside, 'scratch', 'keep.txt'), 'kept');
  return { outside, kept: join(outside, 'scratch', 'keep.txt') };
}

test.skipIf(!posix)('removes only the scratch child of the run', async () => {
  const { id, root, artifactsDir } = runStorage();
  const checkout = join(getRunScratchDir(artifactsDir), 'bisect', 'node_modules', 'pkg');
  await mkdir(checkout, { recursive: true });
  await writeFile(join(artifactsDir, 'report.md'), 'evidence');

  await releaseRunScratch({ id, output_root: root, metadata: {} });

  expect(existsSync(getRunScratchDir(artifactsDir))).toBe(false);
  expect(existsSync(join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR))).toBe(true);
  expect(existsSync(join(artifactsDir, 'report.md'))).toBe(true);
});

test('a planted .archon link is not followed out of the artifacts directory', async () => {
  const { outside, kept } = await outsideScratch();
  const { id, root, artifactsDir } = runStorage();
  await mkdir(artifactsDir, { recursive: true });
  await symlink(outside, join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR));

  await releaseRunScratch({ id, output_root: root, metadata: {} });

  expect(existsSync(kept)).toBe(true);
});

// The run directory replaced after the run's scratch was written: the state a swap
// between any check and the removal leaves behind.
test('a run directory replaced by a link is not followed out of the run', async () => {
  const { outside } = await outsideScratch();
  await mkdir(join(outside, RUN_ARTIFACTS_ENGINE_SUBDIR));
  await rename(join(outside, 'scratch'), join(outside, RUN_ARTIFACTS_ENGINE_SUBDIR, 'scratch'));
  const { artifactsDir } = runStorage();
  await mkdir(getRunScratchDir(artifactsDir), { recursive: true });
  await rename(artifactsDir, `${artifactsDir}-moved`);
  await symlink(outside, artifactsDir);

  await removeRunScratch(artifactsDir, {});

  expect(existsSync(join(outside, RUN_ARTIFACTS_ENGINE_SUBDIR, 'scratch', 'keep.txt'))).toBe(true);
});

test("a container run's scratch is left for its container teardown", async () => {
  const { id, root, artifactsDir } = runStorage();
  const checkout = join(getRunScratchDir(artifactsDir), 'bisect', '.git');
  await mkdir(checkout, { recursive: true });

  await releaseRunScratch({ id, output_root: root, metadata: { isolation: 'container' } });

  expect(existsSync(checkout)).toBe(true);
});
