import { describe, test, expect } from 'bun:test';
import { resolveGithubTokenOverrides, isOrgTokenFallbackAllowed } from './github-token-policy';

describe('resolveGithubTokenOverrides', () => {
  test('no-op when per-user mode is disabled (solo install)', () => {
    expect(resolveGithubTokenOverrides(false, 'user-1', 'ghu_x', {})).toEqual({});
    // even with no user token and no fallback flag
    expect(resolveGithubTokenOverrides(false, null, null, {})).toEqual({});
  });

  test('no-op for server-initiated runs (no originating userId)', () => {
    expect(resolveGithubTokenOverrides(true, null, null, {})).toEqual({});
    expect(resolveGithubTokenOverrides(true, undefined, 'ghu_x', {})).toEqual({});
  });

  test('injects the user token and clears Copilot when the user is connected', () => {
    expect(resolveGithubTokenOverrides(true, 'user-1', 'ghu_user', {})).toEqual({
      GH_TOKEN: 'ghu_user',
      GITHUB_TOKEN: 'ghu_user',
      COPILOT_GITHUB_TOKEN: '',
    });
  });

  test('scrubs all token keys when user not connected and fallback disabled (default)', () => {
    expect(resolveGithubTokenOverrides(true, 'user-1', null, {})).toEqual({
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
    });
  });

  test('keeps the org token when fallback is explicitly enabled', () => {
    const env = { ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: 'true' } as NodeJS.ProcessEnv;
    expect(resolveGithubTokenOverrides(true, 'user-1', null, env)).toEqual({});
    const env1 = { ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: '1' } as NodeJS.ProcessEnv;
    expect(resolveGithubTokenOverrides(true, 'user-1', null, env1)).toEqual({});
  });
});

describe('isOrgTokenFallbackAllowed', () => {
  test('true only for "true"/"1"', () => {
    expect(isOrgTokenFallbackAllowed({ ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: 'true' })).toBe(
      true
    );
    expect(isOrgTokenFallbackAllowed({ ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: '1' })).toBe(true);
    expect(isOrgTokenFallbackAllowed({ ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: 'yes' })).toBe(
      false
    );
    expect(isOrgTokenFallbackAllowed({})).toBe(false);
  });
});
