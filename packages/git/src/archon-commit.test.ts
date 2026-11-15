import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readArchonCommit, withoutRepositorySelectors } from './archon-commit';

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
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-commit-')));
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

describe('readArchonCommit', () => {
  test("names the source checkout's HEAD by short hash and committer date", async () => {
    const root = await repoWithCommit('first');

    expect(await readArchonCommit(root)).toEqual({
      sha: git(root, 'rev-parse', '--short', 'HEAD'),
      committedAt: '2026-11-12T14:03:21+01:00',
    });
  });

  test('names no commit for a source tree without its own git metadata, even inside a checkout', async () => {
    const enclosing = await repoWithCommit('enclosing');
    const sourceRoot = join(enclosing, 'archon');
    await mkdir(sourceRoot);

    expect(await readArchonCommit(sourceRoot)).toBeUndefined();
  });

  test('reads the source checkout even when the process inherited a GIT_DIR', async () => {
    const root = await repoWithCommit('source');
    const other = await repoWithCommit('other');
    const inherited = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, '.git');
    try {
      expect((await readArchonCommit(root))?.sha).toBe(git(root, 'rev-parse', '--short', 'HEAD'));
    } finally {
      if (inherited === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inherited;
    }
  });

  test('names no commit when git fails on a checkout that has git metadata', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-commit-')));
    await writeFile(join(root, '.git'), `gitdir: ${join(root, 'missing')}\n`);

    expect(await readArchonCommit(root)).toBeUndefined();
  });

  // The stand-in gpg is a POSIX shell script.
  test.skipIf(process.platform === 'win32')(
    'names the hash, not signature text, when the commit is signed and log.showSignature is on',
    async () => {
      const root = await repoWithCommit('unsigned');
      // A stand-in for gpg: signs with a fixed block and, when verifying, prints a signature
      // report that `git log` would put in front of its format with log.showSignature.
      const fakeGpg = join(root, 'fake-gpg.sh');
      await writeFile(
        fakeGpg,
        [
          '#!/bin/sh',
          'case "$*" in',
          '  *--verify*)',
          '    echo "[GNUPG:] GOODSIG 0 Test <test@example.com>"',
          '    echo "gpg: Signature made Sun Nov 15 21:31:16 2026 EET" >&2',
          '    ;;',
          '  *)',
          '    cat >/dev/null',
          '    echo "[GNUPG:] SIG_CREATED D 1 8 00 0 0 0" >&2',
          '    printf -- "-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n"',
          '    ;;',
          'esac',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      git(root, 'config', 'gpg.program', fakeGpg);
      git(root, 'commit', '-q', '--allow-empty', '-S', '-m', 'signed');
      git(root, 'config', 'log.showSignature', 'true');
      // Guard against a vacuous test: git must really print signature text here.
      expect(git(root, 'log', '-1', '--format=%h')).toContain('Signature made');

      expect(await readArchonCommit(root)).toEqual({
        sha: git(root, 'rev-parse', '--short', 'HEAD'),
        committedAt: '2026-11-12T14:03:21+01:00',
      });
    }
  );

  test('without a source root, names the Archon checkout, not the working directory', async () => {
    const elsewhere = await repoWithCommit('elsewhere');
    const before = process.cwd();
    process.chdir(elsewhere);
    try {
      const commit = await readArchonCommit();
      expect(commit?.sha).toBeDefined();
      expect(commit?.sha).not.toBe(git(elsewhere, 'rev-parse', '--short', 'HEAD'));
      expect(commit?.sha).toBe(git(import.meta.dir, 'rev-parse', '--short', 'HEAD'));
    } finally {
      process.chdir(before);
    }
  });
});
