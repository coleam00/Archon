import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileAsync } from '@archon/git';
import { removeTempTree } from '@archon/paths/test-utils';
import { withBranchLaunchSource } from './branch-launch-source';

let root: string;
const previousHome = process.env.ARCHON_HOME;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-branch-source-'));
  process.env.ARCHON_HOME = join(root, 'home');
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await writeFile(join(root, 'model.txt'), 'provider-a');
  await git(['add', 'model.txt']);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  await git(['checkout', '-qb', 'adopted']);
  await writeFile(join(root, 'model.txt'), 'provider-b');
  await git(['add', 'model.txt']);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'branch']);
  await git(['checkout', '-q', 'main']);
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  await removeTempTree(root);
});
async function git(args: string[]) {
  return (await execFileAsync('git', args, { cwd: root })).stdout;
}

test.each([false, true])(
  'exports the adopted graph without changing refs or worktrees and cleans up (failure=%s)',
  async failure => {
    const refs = await git(['show-ref']);
    const worktrees = await git(['worktree', 'list', '--porcelain']);
    let snapshotPath = '';
    const prepare = withBranchLaunchSource(root, 'adopted', async snapshot => {
      snapshotPath = snapshot;
      expect(await readFile(join(snapshot, 'model.txt'), 'utf8')).toBe('provider-b');
      expect(await readFile(join(root, 'model.txt'), 'utf8')).toBe('provider-a');
      if (failure) throw new Error('credential refusal');
      return 'prepared-b';
    });
    if (failure) await expect(prepare).rejects.toThrow('credential refusal');
    else expect(await prepare).toBe('prepared-b');
    await expect(readFile(join(snapshotPath, 'model.txt'))).rejects.toThrow();
    expect(await readdir(join(root, 'home', 'temp'))).toEqual([]);
    expect(await git(['show-ref'])).toBe(refs);
    expect(await git(['worktree', 'list', '--porcelain'])).toBe(worktrees);
    expect(await git(['status', '--porcelain', '--untracked-files=no'])).toBe('');
  }
);
