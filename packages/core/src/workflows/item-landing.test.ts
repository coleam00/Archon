// @archon-test-isolated
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileAsync } from '@archon/git';
import { removeTempTree } from '@archon/paths/test-utils';
import { createLandingBranch, LandingBranchCreateError } from './item-landing';

let root: string;
const previousHome = process.env.ARCHON_HOME;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-item-landing-'));
  process.env.ARCHON_HOME = join(root, 'home');
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  await removeTempTree(root);
});

// Creating a landing branch takes the remote a run would use, so a project without one refuses.
test('creating a landing branch refuses a folder project and a project with no remote', async () => {
  const folder = { kind: 'folder' as const, name: 'notes', default_cwd: root };
  await expect(createLandingBranch(folder, 'feat/x', 'main')).rejects.toBeInstanceOf(
    LandingBranchCreateError
  );

  const repo = join(root, 'repo');
  await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
  const unpushed = { kind: 'repo' as const, name: 'solo', default_cwd: repo };
  await expect(createLandingBranch(unpushed, 'feat/x', 'main')).rejects.toBeInstanceOf(
    LandingBranchCreateError
  );
});
