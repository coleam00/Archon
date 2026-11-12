import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readAppCommit } from './app-version';

const trackTempRoot = trackTempRoots();

// Dropped so a test run inside a git hook, which exports these, cannot commit into the
// caller's repository instead of the temporary one.
const REPOSITORY_SELECTORS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
];

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !REPOSITORY_SELECTORS.includes(key))
  );
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, env: { ...env, GIT_COMMITTER_DATE: '2026-11-12T14:03:21+01:00' } }
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function repoWithCommit(message: string): Promise<string> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-app-commit-')));
  git(root, 'init', '-q');
  git(root, 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', message);
  return root;
}

describe('readAppCommit', () => {
  test("names the source checkout's HEAD by short hash and committer date", async () => {
    const root = await repoWithCommit('first');

    expect(await readAppCommit(root)).toEqual({
      sha: git(root, 'rev-parse', '--short', 'HEAD'),
      committedAt: '2026-11-12T14:03:21+01:00',
    });
  });

  test('names no commit for a source tree without its own git metadata, even inside a checkout', async () => {
    const enclosing = await repoWithCommit('enclosing');
    const sourceRoot = join(enclosing, 'archon');
    await mkdir(sourceRoot);

    expect(await readAppCommit(sourceRoot)).toBeUndefined();
  });

  test('reads the source checkout even when the server inherited a GIT_DIR', async () => {
    const root = await repoWithCommit('source');
    const other = await repoWithCommit('other');
    const inherited = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, '.git');
    try {
      expect((await readAppCommit(root))?.sha).toBe(git(root, 'rev-parse', '--short', 'HEAD'));
    } finally {
      if (inherited === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inherited;
    }
  });
});
