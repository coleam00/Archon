import { describe, test, expect, beforeEach } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@archon/git';
import { setLogLevel } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';

import { linkWorktreeFiles } from './worktree-link';

setLogLevel('silent');

const trackTempRoot = trackTempRoots();
let root: string;
let canonical: string;
let worktree: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args])).stdout;
}

beforeEach(async () => {
  root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'archon-worktree-link-'))));
  canonical = join(root, 'canonical');
  // The link check only needs git to read the worktree's .gitignore.
  worktree = join(root, 'worktree');
  await mkdir(worktree);
  await git(worktree, 'init', '-q');
  await mkdir(canonical);
});

describe('linkWorktreeFiles', () => {
  test('links an ignored path to the canonical repo, creating a missing source, and is idempotent', async () => {
    await writeFile(join(worktree, '.gitignore'), '.serena/cache\n');

    expect(await linkWorktreeFiles(canonical, worktree, ['.serena/cache/'])).toEqual([
      '.serena/cache',
    ]);
    const link = join(worktree, '.serena', 'cache');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(join(canonical, '.serena', 'cache'));
    await writeFile(join(link, 'index.db'), 'shared');
    expect(await readFile(join(canonical, '.serena', 'cache', 'index.db'), 'utf8')).toBe('shared');

    expect(await linkWorktreeFiles(canonical, worktree, ['.serena/cache'])).toEqual([
      '.serena/cache',
    ]);
    expect(await realpath(link)).toBe(join(canonical, '.serena', 'cache'));
    expect(await git(worktree, 'status', '--porcelain')).toBe('?? .gitignore\n');
  });

  test('leaves an existing destination alone', async () => {
    await writeFile(join(worktree, '.gitignore'), 'logs\n');
    await mkdir(join(canonical, 'logs'));
    await mkdir(join(worktree, 'logs'));
    await writeFile(join(worktree, 'logs', 'own.log'), 'mine');

    expect(await linkWorktreeFiles(canonical, worktree, ['logs'])).toEqual([]);
    expect((await lstat(join(worktree, 'logs'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(worktree, 'logs', 'own.log'), 'utf8')).toBe('mine');
  });

  test('removes a link git would not ignore', async () => {
    // A directory-only pattern does not match a symlink, which git sees as a file.
    await writeFile(join(worktree, '.gitignore'), 'cache/\n');

    expect(await linkWorktreeFiles(canonical, worktree, ['cache'])).toEqual([]);
    expect(await readdir(worktree)).not.toContain('cache');
    expect(await git(worktree, 'status', '--porcelain')).toBe('?? .gitignore\n');
  });

  test('refuses a path outside either root', async () => {
    expect(await linkWorktreeFiles(canonical, worktree, ['../escape'])).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(['canonical', 'worktree']);
  });
});
