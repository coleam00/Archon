import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readTar } from './plugin-tar';
import { tarGz } from './plugin-tar-fixture';

const tempRoot = trackTempRoots();

const read = (entries: Parameters<typeof tarGz>[0]): ReturnType<typeof readTar> =>
  readTar(Bun.gunzipSync(tarGz(entries)));

describe('readTar', () => {
  test('reports links and escaping names as written, which Bun.Archive would drop or rewrite', () => {
    const entries = read([
      { path: 'repo-abc/pack/', type: '5' },
      { path: 'repo-abc/pack/ok.yaml', data: 'name: ok\n' },
      { path: 'repo-abc/pack/link', type: '2', link: '/etc/passwd' },
      { path: 'repo-abc/pack/hard', type: '1', link: 'repo-abc/pack/ok.yaml' },
      { path: 'repo-abc/../../escape.txt', data: 'x' },
    ]);
    expect(entries.map(({ path, kind }) => [path, kind])).toEqual([
      ['repo-abc/pack', 'directory'],
      ['repo-abc/pack/ok.yaml', 'file'],
      ['repo-abc/pack/link', 'symlink'],
      ['repo-abc/pack/hard', 'hardlink'],
      ['repo-abc/../../escape.txt', 'file'],
    ]);
    expect(new TextDecoder().decode(entries[1].data)).toBe('name: ok\n');
  });

  test('takes long names from pax headers and keeps the execute bit', () => {
    const long = `repo-abc/${'a'.repeat(90)}/${'b'.repeat(90)}.ts`;
    const [entry] = read([{ path: long, data: 'x', mode: 0o755 }]);
    expect(entry.path).toBe(long);
    expect(entry.executable).toBe(true);
  });

  // GitHub's codeload tarballs are `git archive` output: a global pax header
  // carrying the commit, pax long names, symlinks as entries, modes from git.
  test('reads what git archive writes', async () => {
    const repo = tempRoot(await mkdtemp(join(tmpdir(), 'plugin-tar-')));
    const git = (...args: string[]): Buffer => {
      const result = Bun.spawnSync(
        ['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
        { cwd: repo }
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout;
    };
    const long = `${'d'.repeat(80)}/${'f'.repeat(80)}.ts`;
    await mkdir(join(repo, 'd'.repeat(80)));
    await writeFile(join(repo, long), 'x');
    await writeFile(join(repo, 'run.sh'), '#!/bin/sh\n');
    git('init', '-q');
    git('add', '.');
    git('update-index', '--chmod=+x', 'run.sh');
    // Staged as a symlink object directly, so the test needs no symlink support
    // from the filesystem (Windows).
    await writeFile(join(repo, 'target.txt'), 'run.sh');
    const blob = git('hash-object', '-w', 'target.txt').toString().trim();
    git('update-index', '--add', '--cacheinfo', `120000,${blob},link`);
    git('commit', '-q', '-m', 'fixture');
    const entries = readTar(new Uint8Array(git('archive', '--prefix=repo-abc/', 'HEAD')));
    const byPath = new Map(entries.map(entry => [entry.path, entry]));
    expect(byPath.get(`repo-abc/${long}`)?.kind).toBe('file');
    expect(byPath.get('repo-abc/run.sh')?.executable).toBe(true);
    expect(byPath.get(`repo-abc/${long}`)?.executable).toBe(false);
    expect(byPath.get('repo-abc/link')?.kind).toBe('symlink');
  });

  test('refuses a truncated archive instead of returning part of it', () => {
    const tar = Bun.gunzipSync(tarGz([{ path: 'repo/a.txt', data: 'x'.repeat(2000) }]));
    expect(() => readTar(tar.subarray(0, 1024))).toThrow('Truncated tar archive');
  });
});
