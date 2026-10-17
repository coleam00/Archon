// @archon-test-isolated
import { test, expect, mock, spyOn } from 'bun:test';
import { mkdtemp, mkdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '@archon/git';
import { trackTempRoots } from '@archon/paths/test-utils';
import type * as CodebaseDb from '../db/codebases';

const trackTempRoot = trackTempRoots();
const createCodebase = mock<typeof CodebaseDb.createCodebase>(async input => ({
  id: 'app-codebase',
  name: input.name,
  repository_url: input.repository_url ?? null,
  default_cwd: input.default_cwd,
  default_branch: input.default_branch ?? null,
  ai_assistant_type: 'claude',
  kind: 'repo',
  commands: {},
  created_at: new Date(),
  updated_at: new Date(),
}));
mock.module('../db/codebases', () => ({
  createCodebase,
  listCodebaseClaims: async () => [],
  findCodebaseByName: async () => null,
  findCodebaseByRepoUrl: async () => null,
  getCodebaseCommands: async () => ({}),
  updateCodebaseCommands: async () => {},
}));
const { cloneRepository } = await import('./sql-registration');

test('App URL registration composes installation credentials with real helper Git configuration', async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'app-registration-')));
  const savedEnv = {
    ARCHON_HOME: process.env.ARCHON_HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.ARCHON_HOME = root;
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const remoteUrl = 'https://github.com/owner/private-repo.git';
  const getInstallationToken = mock(async () => 'synthetic-installation-token');
  const options = { githubAppAuth: { getInstallationToken } };
  const clone = spyOn(git, 'cloneRepository').mockImplementation(async (url, path) => {
    await mkdir(path, { recursive: true });
    await git.execFileAsync('git', ['init', path]);
    await git.execFileAsync('git', ['-C', path, 'remote', 'add', 'origin', url]);
    return { ok: true, value: undefined };
  });
  try {
    const result = await cloneRepository(remoteUrl, options);
    expect(clone).toHaveBeenCalledWith(remoteUrl, git.toRepoPath(result.defaultCwd), {
      credentials: { username: 'x-access-token', password: 'synthetic-installation-token' },
    });
    const config = async (key: string) =>
      (
        await git.execFileAsync('git', ['-C', result.defaultCwd, 'config', '--local', '--get', key])
      ).stdout.trim();
    expect(await config('remote.origin.url')).toBe(remoteUrl);
    expect(await config('credential.https://github.com.helper')).toContain(
      join(root, 'bin', 'git-credential-archon')
    );
    expect(await config('credential.https://github.com.useHttpPath')).toBe('true');
    const helper = join(root, 'bin', 'git-credential-archon');
    expect((await readFile(helper, 'utf8')).length).toBeGreaterThan(0);
    if (process.platform !== 'win32') expect((await stat(helper)).mode & 0o111).not.toBe(0);
    expect(result.repositoryUrl).toBe(remoteUrl);
    expect(createCodebase).toHaveBeenCalledTimes(1);
  } finally {
    clone.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
