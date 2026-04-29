import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as repo from './repo';
import { detectForge } from './forge';
import { toRepoPath } from './types';

const testRepo = toRepoPath('/tmp/test-repo');

describe('detectForge', () => {
  let getRemoteUrlSpy: ReturnType<typeof spyOn>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    getRemoteUrlSpy = spyOn(repo, 'getRemoteUrl');
    // Save env vars we'll mutate
    savedEnv.GITEA_URL = process.env.GITEA_URL;
    savedEnv.GITLAB_URL = process.env.GITLAB_URL;
    delete process.env.GITEA_URL;
    delete process.env.GITLAB_URL;
  });

  afterEach(() => {
    getRemoteUrlSpy.mockRestore();
    // Restore env
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
