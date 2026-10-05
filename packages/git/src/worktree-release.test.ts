import { beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { execFileAsync } from './exec';
import { inspectWorktreeForRelease, verifyWorktreeCommitsPushed } from './branch';
import { toWorktreePath, type WorktreePath } from './types';

const track = trackTempRoots();
let path: WorktreePath;
beforeEach(async () => {
  const root = track(await realpath(await mkdtemp(join(tmpdir(), 'archon-git-release-'))));
  path = toWorktreePath(join(root, 'checkout'));
  await mkdir(path);
  const git = (...args: string[]) => execFileAsync('git', ['-C', path, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(path, 'file'), 'original');
  await git('add', '.');
  await git('commit', '-qm', 'initial');
});

test('strict inspection fails when git cannot inspect the checkout', async () => {
  await expect(inspectWorktreeForRelease(toWorktreePath(join(path, 'missing')))).rejects.toThrow();
});

test.each(['', 'missing', '--upload-pack=evil', 'remote*'])(
  'unverifiable remote %s is a refusal, never zero commits',
  async remote => {
    await expect(verifyWorktreeCommitsPushed(path, remote)).rejects.toThrow('unknown remote');
  }
);

test('strict inspection reports HEAD and rejects ignored files too', async () => {
  const { head } = await inspectWorktreeForRelease(path);
  expect(head).toBe((await execFileAsync('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim());
  await writeFile(join(path, '.git', 'info', 'exclude'), '*.secret\n');
  await writeFile(join(path, 'operator.secret'), 'preserve');
  await expect(inspectWorktreeForRelease(path)).rejects.toThrow('ignored');
});
