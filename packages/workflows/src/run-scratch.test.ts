import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
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

  await releaseRunScratch({ id, output_root: root, metadata: {} });

  expect(existsSync(getRunScratchDir(artifactsDir))).toBe(false);
  expect(existsSync(join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR))).toBe(true);
  expect(existsSync(join(artifactsDir, 'report.md'))).toBe(true);
});

test("a container run's scratch is left for its container teardown", async () => {
  const { id, root, artifactsDir } = runStorage();
  const checkout = join(getRunScratchDir(artifactsDir), 'bisect', '.git');
  await mkdir(checkout, { recursive: true });

  await releaseRunScratch({ id, output_root: root, metadata: { isolation: 'container' } });

  expect(existsSync(checkout)).toBe(true);
});

// The terminal status write is authoritative, so a scratch entry that cannot be deleted
// must not fail the executor exit, a store write or a container teardown.
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
