import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  getRunScratchDir,
  RUN_ARTIFACTS_ENGINE_SUBDIR,
} from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { releaseRunScratch } from './run-scratch';

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
