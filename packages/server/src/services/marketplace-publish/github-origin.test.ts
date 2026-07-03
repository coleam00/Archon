import { describe, test, expect } from 'bun:test';
import { parseGitHubOrigin, probeRepoCapability } from './github-origin';
import type { Octokit } from '@octokit/rest';

describe('parseGitHubOrigin', () => {
  test('parses https URL', () => {
    expect(parseGitHubOrigin('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  test('parses https URL with .git suffix', () => {
    expect(parseGitHubOrigin('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  test('parses ssh form', () => {
    expect(parseGitHubOrigin('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  test('parses ssh form without .git suffix', () => {
    expect(parseGitHubOrigin('git@github.com:owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  test('strips token-embedded userinfo from https URL', () => {
    expect(parseGitHubOrigin('https://ghp_supersecret@github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  test('rejects non-github hosts', () => {
    expect(parseGitHubOrigin('https://gitlab.com/owner/repo')).toBeNull();
  });

  test('rejects malformed URLs', () => {
    expect(parseGitHubOrigin('not a url')).toBeNull();
  });

  test('rejects empty string', () => {
    expect(parseGitHubOrigin('')).toBeNull();
  });

  test('rejects a bare host with no owner/repo', () => {
    expect(parseGitHubOrigin('https://github.com/')).toBeNull();
  });

  test('rejects a path with extra segments', () => {
    expect(parseGitHubOrigin('https://github.com/owner/repo/extra')).toBeNull();
  });

  test('never leaks the embedded token in the returned value', () => {
    const result = parseGitHubOrigin('https://ghp_supersecret@github.com/owner/repo.git');
    expect(JSON.stringify(result)).not.toContain('ghp_supersecret');
  });
});

describe('probeRepoCapability', () => {
  function makeOctokit(data: {
    private?: boolean;
    archived?: boolean;
    default_branch?: string;
    permissions?: { push?: boolean };
  }): Octokit {
    return {
      rest: {
        repos: {
          get: async () => ({
            data: {
              private: data.private ?? false,
              archived: data.archived ?? false,
              default_branch: data.default_branch ?? 'main',
              permissions: data.permissions,
            },
          }),
        },
      },
    } as unknown as Octokit;
  }

  test('returns defaultBranch on a public, writable, non-archived repo', async () => {
    const octokit = makeOctokit({ default_branch: 'dev', permissions: { push: true } });
    const result = await probeRepoCapability(octokit, 'owner', 'repo');
    expect(result).toEqual({ ok: true, capability: { defaultBranch: 'dev' } });
  });

  test('blocks on private', async () => {
    const octokit = makeOctokit({ private: true, permissions: { push: true } });
    const result = await probeRepoCapability(octokit, 'owner', 'repo');
    expect(result).toEqual({ ok: false, reason: 'private' });
  });

  test('blocks on archived', async () => {
    const octokit = makeOctokit({ archived: true, permissions: { push: true } });
    const result = await probeRepoCapability(octokit, 'owner', 'repo');
    expect(result).toEqual({ ok: false, reason: 'archived' });
  });

  test('blocks when permissions.push is not true', async () => {
    const octokit = makeOctokit({ permissions: { push: false } });
    const result = await probeRepoCapability(octokit, 'owner', 'repo');
    expect(result).toEqual({ ok: false, reason: 'no-push-permission' });
  });

  test('blocks when permissions is undefined (device-flow token, no App coverage)', async () => {
    const octokit = makeOctokit({});
    const result = await probeRepoCapability(octokit, 'owner', 'repo');
    expect(result).toEqual({ ok: false, reason: 'no-push-permission' });
  });

  test('private takes precedence over push-permission', async () => {
    const octokit = makeOctokit({ private: true, permissions: { push: false } });
    const result = await probeRepoCapability(octokit, 'owner', 'repo');
    expect(result).toEqual({ ok: false, reason: 'private' });
  });
});
