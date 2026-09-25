import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readSourceCommit } from './source-commit';
import { trackTempRoots } from './test-utils';

const tempRoots = trackTempRoots();
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER = 'ffffffffffffffffffffffffffffffffffffffff';

function checkout(): { root: string; gitDir: string } {
  const root = tempRoots(mkdtempSync(join(tmpdir(), 'archon-source-commit-')));
  const gitDir = join(root, '.git');
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  return { root, gitDir };
}

describe('readSourceCommit', () => {
  test('resolves a branch ref from a nested directory', () => {
    const { root, gitDir } = checkout();
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/dev\n');
    writeFileSync(join(gitDir, 'refs', 'heads', 'dev'), `${SHA}\n`);
    const nested = join(root, 'packages', 'paths', 'src');
    mkdirSync(nested, { recursive: true });
    expect(readSourceCommit(nested)).toBe('a1b2c3d');
  });

  test('resolves a detached HEAD', () => {
    const { root, gitDir } = checkout();
    writeFileSync(join(gitDir, 'HEAD'), `${SHA}\n`);
    expect(readSourceCommit(root)).toBe('a1b2c3d');
  });

  test('falls back to packed-refs', () => {
    const { root, gitDir } = checkout();
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(gitDir, 'packed-refs'),
      `# pack-refs with: peeled\n${OTHER} refs/heads/dev\n${SHA} refs/heads/main\n`
    );
    expect(readSourceCommit(root)).toBe('a1b2c3d');
  });

  test('follows a linked worktree to the shared refs', () => {
    const { gitDir } = checkout();
    writeFileSync(join(gitDir, 'refs', 'heads', 'feature'), `${SHA}\n`);
    const worktreeGitDir = join(gitDir, 'worktrees', 'wt');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n');
    const worktree = tempRoots(mkdtempSync(join(tmpdir(), 'archon-source-commit-wt-')));
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);
    expect(readSourceCommit(worktree)).toBe('a1b2c3d');
  });

  test('returns undefined for an unresolvable ref or a malformed HEAD', () => {
    const { root, gitDir } = checkout();
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/missing\n');
    expect(readSourceCommit(root)).toBeUndefined();
    writeFileSync(join(gitDir, 'HEAD'), 'not a sha\n');
    expect(readSourceCommit(root)).toBeUndefined();
  });
});
