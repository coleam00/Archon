import { describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { toWorktreePath } from './types';
import { refreshWorktreeIndex } from './worktree';

const trackTempRoot = trackTempRoots();

function git(cwd: string, args: string[], input?: string): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

describe('refreshWorktreeIndex', () => {
  test('leaves no tracked file racily clean in a worktree just created', async () => {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'refresh-worktree-index-')));
    const repo = join(root, 'repo');
    git(root, ['init', '--bare', '-q', '-b', 'main', repo]);
    // Import the fixture directly: a second checkout and its add/commit scans only
    // add filesystem and process contention to the Windows suite.
    const files = Array.from({ length: 200 }, (_, i) => {
      const contents = `${i}\n`;
      return `M 100644 inline f${i}.txt\ndata ${String(Buffer.byteLength(contents))}\n${contents}`;
    }).join('');
    git(
      repo,
      ['fast-import', '--quiet'],
      `commit refs/heads/main\ncommitter T <t@e.com> 0 +0000\ndata 6\nfiles\n${files}\n`
    );
    const worktree = join(root, 'worktree');
    git(repo, ['worktree', 'add', '-q', worktree]);

    await refreshWorktreeIndex(toWorktreePath(worktree));

    // Git compares whole seconds: an entry whose file second is not older than the
    // index file's second is racily clean and re-hashed by every read-only status.
    const index = git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const indexSecond = Math.floor(statSync(index).mtimeMs / 1000);
    const fileSeconds = [...git(worktree, ['ls-files', '--debug']).matchAll(/mtime: (\d+):/g)].map(
      match => Number(match[1])
    );
    expect(fileSeconds).toHaveLength(200);
    expect(fileSeconds.filter(second => second >= indexSecond)).toEqual([]);
  });
});
