import { describe, test, expect } from 'bun:test';
import {
  resolveGithubTokenOverrides,
  applyGithubTokenOverridesToProcessEnv,
  scrubAgentEnv,
  AGENT_ENV_DENYLIST,
} from './github-token-policy';

describe('resolveGithubTokenOverrides', () => {
  test('no-op when per-user mode is disabled (solo install)', () => {
    expect(resolveGithubTokenOverrides(false, 'user-1', 'ghu_x')).toEqual({});
    expect(resolveGithubTokenOverrides(false, null, null)).toEqual({});
  });

  test('injects the user token and clears Copilot when the user is connected', () => {
    expect(resolveGithubTokenOverrides(true, 'user-1', 'ghu_user')).toEqual({
      GH_TOKEN: 'ghu_user',
      GITHUB_TOKEN: 'ghu_user',
      COPILOT_GITHUB_TOKEN: '',
    });
  });

  test('scrubs all token keys when user not connected and fallback disabled (default)', () => {
    expect(resolveGithubTokenOverrides(true, 'user-1', null)).toEqual({
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
    });
  });

  test('scrubs tokens when userId absent and per-user mode is on', () => {
    expect(resolveGithubTokenOverrides(true, null, null)).toEqual({
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
    });
    expect(resolveGithubTokenOverrides(true, undefined, undefined)).toEqual({
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
    });
  });
});

describe('applyGithubTokenOverridesToProcessEnv', () => {
  test('sets non-empty values and deletes empty ones', () => {
    const base = { GH_TOKEN: 'org', GITHUB_TOKEN: 'org', PATH: '/bin' } as NodeJS.ProcessEnv;
    const out = applyGithubTokenOverridesToProcessEnv(base, {
      GH_TOKEN: 'user',
      GITHUB_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
    });
    expect(out.GH_TOKEN).toBe('user');
    expect('GITHUB_TOKEN' in out).toBe(false);
    expect('COPILOT_GITHUB_TOKEN' in out).toBe(false);
    expect(out.PATH).toBe('/bin'); // untouched
  });

  test('does not mutate the input env', () => {
    const base = { GH_TOKEN: 'org' } as NodeJS.ProcessEnv;
    applyGithubTokenOverridesToProcessEnv(base, { GH_TOKEN: '' });
    expect(base.GH_TOKEN).toBe('org');
  });
});

describe('scrubAgentEnv (issue #126)', () => {
  test('removes every denylisted secret from the returned env', () => {
    const dirty = {
      GITHUB_APP_PRIVATE_KEY: 'base64-pem',
      GITHUB_APP_PRIVATE_KEY_PATH: '/run/secrets/app.pem',
      GITHUB_APP_ID: '148580',
      GITHUB_APP_CLIENT_ID: 'Iv1.abc',
      TOKEN_ENCRYPTION_KEY: 'aeskey',
      DATABASE_URL: 'postgres://u:p@h/db',
      WEBHOOK_SECRET: 'hmac-shared-secret',
      GH_TOKEN: 'ghs_installation',
      PATH: '/usr/bin',
    };
    const clean = scrubAgentEnv(dirty);
    for (const k of AGENT_ENV_DENYLIST) {
      expect(clean[k]).toBeUndefined();
    }
    // Non-secret and sanctioned-auth vars are preserved.
    expect(clean.GH_TOKEN).toBe('ghs_installation');
    expect(clean.PATH).toBe('/usr/bin');
  });

  test('does not mutate the input env', () => {
    const input = { GITHUB_APP_PRIVATE_KEY: 'x' };
    scrubAgentEnv(input);
    expect(input.GITHUB_APP_PRIVATE_KEY).toBe('x');
  });

  test('WEBHOOK_SECRET is scrubbed (forged-event attack guard)', () => {
    expect(scrubAgentEnv({ WEBHOOK_SECRET: 'my-secret' }).WEBHOOK_SECRET).toBeUndefined();
  });
});
