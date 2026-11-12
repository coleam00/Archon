import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readAppCommit } from './app-version';

const trackTempRoot = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-12T14:03:21+01:00' } }
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe('readAppCommit', () => {
  test("names the source checkout's HEAD by short hash and committer date", async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-app-commit-')));
    git(root, 'init', '-q');
    git(root, 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'first');

    expect(await readAppCommit(root)).toEqual({
      sha: git(root, 'rev-parse', '--short', 'HEAD'),
      committedAt: '2026-11-12T14:03:21+01:00',
    });
  });

  test('names no commit for a source tree without git metadata', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-app-commit-')));
    expect(await readAppCommit(root)).toBeUndefined();
  });
});
