import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  RUN_ARTIFACTS_ENGINE_SUBDIR,
} from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { releaseRunScratch } from './run-scratch';

const trackTempRoot = trackTempRoots();

test('a planted .archon link is not followed out of the artifacts directory', async () => {
  const outside = trackTempRoot(await mkdtemp(join(tmpdir(), 'run-scratch-outside-')));
  await mkdir(join(outside, 'scratch'));
  await writeFile(join(outside, 'scratch', 'keep.txt'), 'kept');
  const id = crypto.randomUUID();
  const root = trackTempRoot(join(getArchonWorkspacesPath(), '_cwd', `run-scratch-${id}`));
  const artifactsDir = getRunArtifactsDirForRoot(root, id);
  await mkdir(artifactsDir, { recursive: true });
  await symlink(outside, join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR));

  await releaseRunScratch({ id, output_root: root });

  expect(existsSync(join(outside, 'scratch', 'keep.txt'))).toBe(true);
});
