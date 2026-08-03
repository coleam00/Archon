import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import * as repo from './repo';
import { detectForge } from './forge';
import { toRepoPath } from './types';

const testRepo = toRepoPath('/tmp/test-repo');

const FORGE_ENV_VARS = ['GITHUB_URL', 'GITEA_URL', 'GITLAB_URL'] as const;

describe('detectForge', () => {
  let getRemoteUrlSpy: Mock<typeof repo.getRemoteUrl>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    getRemoteUrlSpy = spyOn(repo, 'getRemoteUrl');
    // Save + clear the env vars the detector reads so ambient values can't
    // leak into assertions
    for (const key of FORGE_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    getRemoteUrlSpy.mockRestore();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  test('detects GitHub from HTTPS remote', async () => {
    getRemoteUrlSpy.mockResolvedValue('https://github.com/owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('github');
    expect(info.apiBase).toBe('https://api.github.com');
  });

  test('detects GitHub from SSH remote', async () => {
    getRemoteUrlSpy.mockResolvedValue('git@github.com:owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('github');
    expect(info.apiBase).toBe('https://api.github.com');
  });

  test('forwards a custom remote name to getRemoteUrl', async () => {
    getRemoteUrlSpy.mockResolvedValue('https://github.com/owner/repo.git');
    const info = await detectForge(testRepo, 'upstream');
    expect(info.type).toBe('github');
    expect(getRemoteUrlSpy).toHaveBeenCalledWith(testRepo, 'upstream');
  });

  test('detects GitHub Enterprise when GITHUB_URL env matches remote hostname', async () => {
    process.env.GITHUB_URL = 'https://github.corp.com';
    getRemoteUrlSpy.mockResolvedValue('https://github.corp.com/owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('github');
    expect(info.apiBase).toBe('https://github.corp.com/api/v3');
  });

  test('detects Gitea when GITEA_URL env matches remote hostname', async () => {
    process.env.GITEA_URL = 'https://gitea.example.com';
    getRemoteUrlSpy.mockResolvedValue('https://gitea.example.com/owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('gitea');
    expect(info.apiBase).toBe('https://gitea.example.com/api/v1');
  });

  test('detects Gitea with trailing slash in GITEA_URL', async () => {
    process.env.GITEA_URL = 'https://gitea.example.com/';
    getRemoteUrlSpy.mockResolvedValue('https://gitea.example.com/owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('gitea');
    expect(info.apiBase).toBe('https://gitea.example.com/api/v1');
  });

  test('detects Gitea from SSH remote', async () => {
    process.env.GITEA_URL = 'https://gitea.example.com';
    getRemoteUrlSpy.mockResolvedValue('git@gitea.example.com:owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('gitea');
    expect(info.apiBase).toBe('https://gitea.example.com/api/v1');
  });

  test('detects GitLab from gitlab.com remote', async () => {
    getRemoteUrlSpy.mockResolvedValue('https://gitlab.com/owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('gitlab');
    expect(info.apiBase).toBe('https://gitlab.com/api/v4');
  });

  test('detects GitLab from SSH remote', async () => {
    getRemoteUrlSpy.mockResolvedValue('git@gitlab.com:owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('gitlab');
    expect(info.apiBase).toBe('https://gitlab.com/api/v4');
  });

  test('detects self-hosted GitLab when GITLAB_URL env matches', async () => {
    process.env.GITLAB_URL = 'https://gitlab.corp.com';
    getRemoteUrlSpy.mockResolvedValue('https://gitlab.corp.com/team/project.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('gitlab');
    expect(info.apiBase).toBe('https://gitlab.corp.com/api/v4');
  });

  test('returns unknown for unrecognized remote', async () => {
    getRemoteUrlSpy.mockResolvedValue('https://bitbucket.org/owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('unknown');
    expect(info.apiBase).toBe('');
  });

  test('returns unknown for a remote with no parseable hostname', async () => {
    getRemoteUrlSpy.mockResolvedValue('/local/bare/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('unknown');
    expect(info.apiBase).toBe('');
  });

  test('defaults to github when no remote exists', async () => {
    getRemoteUrlSpy.mockResolvedValue(null);
    const info = await detectForge(testRepo);
    expect(info.type).toBe('github');
    expect(info.apiBase).toBe('https://api.github.com');
  });

  test('ignores invalid GITEA_URL env value', async () => {
    process.env.GITEA_URL = 'not-a-url';
    getRemoteUrlSpy.mockResolvedValue('https://gitea.example.com/owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('unknown');
    expect(info.apiBase).toBe('');
  });

  test('Gitea detection is case-insensitive on hostname', async () => {
    process.env.GITEA_URL = 'https://Gitea.Example.COM';
    getRemoteUrlSpy.mockResolvedValue('https://gitea.example.com/owner/repo.git');
    const info = await detectForge(testRepo);
    expect(info.type).toBe('gitea');
  });
});
