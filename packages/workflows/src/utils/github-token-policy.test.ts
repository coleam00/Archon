import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  isMultiUserMode,
  isOrgTokenFallbackAllowed,
  resolveGithubTokenOverrides,
  applyGithubTokenOverridesToProcessEnv,
  GITHUB_TOKEN_KEYS,
} from './github-token-policy';

const ORIG = {
  KEYCLOAK_URL: process.env.KEYCLOAK_URL,
  ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK,
};

function restore(): void {
  if (ORIG.KEYCLOAK_URL === undefined) delete process.env.KEYCLOAK_URL;
  else process.env.KEYCLOAK_URL = ORIG.KEYCLOAK_URL;
  if (ORIG.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK === undefined)
    delete process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK;
  else
    process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK =
      ORIG.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK;
}

describe('isMultiUserMode', () => {
  beforeEach(restore);
  afterEach(restore);

  test('false when KEYCLOAK_URL unset', () => {
    delete process.env.KEYCLOAK_URL;
    expect(isMultiUserMode()).toBe(false);
  });
  test('true when KEYCLOAK_URL set to any non-empty value', () => {
    process.env.KEYCLOAK_URL = 'https://keycloak.example.com';
    expect(isMultiUserMode()).toBe(true);
  });
});

describe('isOrgTokenFallbackAllowed', () => {
  beforeEach(restore);
  afterEach(restore);

  test('default false when unset', () => {
    delete process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK;
    expect(isOrgTokenFallbackAllowed()).toBe(false);
  });
  test('false for any non-matching value', () => {
    process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK = 'yes';
    expect(isOrgTokenFallbackAllowed()).toBe(false);
    process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK = '';
    expect(isOrgTokenFallbackAllowed()).toBe(false);
  });
  test('true for "true" or "1"', () => {
    process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK = 'true';
    expect(isOrgTokenFallbackAllowed()).toBe(true);
    process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK = '1';
    expect(isOrgTokenFallbackAllowed()).toBe(true);
  });
});

describe('resolveGithubTokenOverrides', () => {
  beforeEach(restore);
  afterEach(restore);

  test('single-user mode: returns {} regardless of user/token', () => {
    delete process.env.KEYCLOAK_URL;
    expect(resolveGithubTokenOverrides(null, null)).toEqual({});
    expect(resolveGithubTokenOverrides('user-1', null)).toEqual({});
    expect(resolveGithubTokenOverrides('user-1', 'ghp_user_token')).toEqual({});
  });

  test('multi-user mode, server-initiated (no userId): returns {} — trusted org context', () => {
    process.env.KEYCLOAK_URL = 'https://kc';
    expect(resolveGithubTokenOverrides(null, null)).toEqual({});
    expect(resolveGithubTokenOverrides(undefined, null)).toEqual({});
  });

  test('multi-user, user has personal token: injects token, clears Copilot key', () => {
    process.env.KEYCLOAK_URL = 'https://kc';
    expect(resolveGithubTokenOverrides('user-1', 'ghp_personal')).toEqual({
      GH_TOKEN: 'ghp_personal',
      GITHUB_TOKEN: 'ghp_personal',
      COPILOT_GITHUB_TOKEN: '',
    });
  });

  test('multi-user, user has no token, fallback disabled (default): scrubs all', () => {
    process.env.KEYCLOAK_URL = 'https://kc';
    delete process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK;
    expect(resolveGithubTokenOverrides('user-1', null)).toEqual({
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
    });
  });

  test('multi-user, user has no token, fallback enabled: returns {} — org token kept', () => {
    process.env.KEYCLOAK_URL = 'https://kc';
    process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK = 'true';
    expect(resolveGithubTokenOverrides('user-1', null)).toEqual({});
  });
});

describe('applyGithubTokenOverridesToProcessEnv', () => {
  test('empty-string overrides delete the key', () => {
    const base = { GH_TOKEN: 'org', GITHUB_TOKEN: 'org', UNRELATED: 'keep' };
    const out = applyGithubTokenOverridesToProcessEnv(base, {
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    });
    expect(out).toEqual({ UNRELATED: 'keep' });
  });

  test('non-empty overrides set the key', () => {
    const base = { GH_TOKEN: 'org', UNRELATED: 'keep' };
    const out = applyGithubTokenOverridesToProcessEnv(base, { GH_TOKEN: 'user' });
    expect(out).toEqual({ GH_TOKEN: 'user', UNRELATED: 'keep' });
  });

  test('empty overrides leave env unchanged', () => {
    const base = { GH_TOKEN: 'org' };
    const out = applyGithubTokenOverridesToProcessEnv(base, {});
    expect(out).toEqual({ GH_TOKEN: 'org' });
    // Returns a new object (caller is allowed to mutate the result)
    expect(out).not.toBe(base);
  });
});

describe('GITHUB_TOKEN_KEYS', () => {
  test('lists the three sensitive keys', () => {
    expect(GITHUB_TOKEN_KEYS).toEqual(['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN']);
  });
});
