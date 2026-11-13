import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLogLines, trackTempRoots } from '@archon/paths/test-utils';
import { readAppCommit, withoutRepositorySelectors } from './app-version';

const trackTempRoot = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  // A test run inside a git hook inherits GIT_DIR; without this the commit below would
  // land in the caller's repository instead of the temporary one.
  const env = withoutRepositorySelectors(process.env);
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

describe('withoutRepositorySelectors', () => {
  test('drops every variable that selects another repository, in any case, and keeps the rest', () => {
    const env = {
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/.git/index',
      GIT_OBJECT_DIRECTORY: '/elsewhere/.git/objects',
      GIT_COMMON_DIR: '/elsewhere/.git',
      git_dir: '/lowercase/.git',
      GIT_CEILING_DIRECTORIES: '/ceiling',
      PATH: '/usr/bin',
    };
    expect(withoutRepositorySelectors(env)).toEqual({
      GIT_CEILING_DIRECTORIES: '/ceiling',
      PATH: '/usr/bin',
    });
  });
});

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

  test('warns, and names no commit, when git fails on a checkout that has git metadata', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-app-commit-')));
    await writeFile(join(root, '.git'), `gitdir: ${join(root, 'missing')}\n`);
    const logs = captureLogLines();
    try {
      expect(await readAppCommit(root)).toBeUndefined();
      expect(logs.lines).toContainEqual(
        expect.objectContaining({ level: 40, msg: 'app_commit.read_failed', sourceRoot: root })
      );
    } finally {
      logs.restore();
    }
  });
});
