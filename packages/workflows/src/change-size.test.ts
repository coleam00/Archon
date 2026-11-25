import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { measureChangeSize } from './change-size';
import type { ResultCommit } from './schemas/terminal-record';

const trackTempRoot = trackTempRoots();
const HOST = { kind: 'host' } as const;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index}\n`).join('');
}

/** A repository on `main` with one commit, which is the base. */
function repo(): { dir: string; base: string } {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'change-size-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'readme\n');
  return { dir, base: commit(dir) };
}

function commit(dir: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  return git(dir, 'rev-parse', 'HEAD');
}

function heldAt(commitId: string): ResultCommit {
  return { held: true, commit: commitId };
}

describe('measureChangeSize', () => {
  test('counts files and lines from the merge-base with the base branch to the result commit', async () => {
    const { dir, base } = repo();
    git(dir, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(dir, 'a.txt'), lines(40));
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]));
    const head = commit(dir);

    expect(await measureChangeSize(dir, HOST, heldAt(head), 'main', undefined, 'run')).toEqual({
      base,
      files: 2,
      added: 40,
      removed: 0,
    });
  });

  test('measures against the remote base, not a stale local branch', async () => {
    const { dir, base } = repo();
    writeFileSync(join(dir, 'upstream.txt'), lines(5));
    const upstream = commit(dir);
    git(dir, 'remote', 'add', 'origin', dir);
    git(dir, 'update-ref', 'refs/remotes/origin/main', upstream);
    git(dir, 'reset', '-q', '--hard', base);
    git(dir, 'checkout', '-q', '-b', 'work', upstream);
    writeFileSync(join(dir, 'a.txt'), lines(3));
    const head = commit(dir);

    expect(await measureChangeSize(dir, HOST, heldAt(head), 'main', undefined, 'run')).toEqual({
      base: upstream,
      files: 1,
      added: 3,
      removed: 0,
    });
  });

  test('records no size, not zero, when there is no commit or no base to measure from', async () => {
    const { dir, base } = repo();
    const notHeld: ResultCommit = { held: false, reason: 'dirty' };

    expect(await measureChangeSize(dir, HOST, notHeld, 'main', undefined, 'run')).toBeUndefined();
    expect(await measureChangeSize(dir, HOST, heldAt(base), '', undefined, 'run')).toBeUndefined();
    expect(
      await measureChangeSize(dir, HOST, heldAt(base), 'no-such-branch', undefined, 'run')
    ).toBeUndefined();
  });
});
