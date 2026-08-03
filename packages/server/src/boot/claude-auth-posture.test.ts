import { describe, test, expect } from 'bun:test';
import { shouldDefaultClaudeGlobalAuth, hasClaudeBootAuthPosture } from './claude-auth-posture';

describe('shouldDefaultClaudeGlobalAuth', () => {
  test('solo install with no creds → true (preserves the claude /login fallback)', () => {
    expect(shouldDefaultClaudeGlobalAuth({})).toBe(true);
  });

  test('per-user install (TOKEN_ENCRYPTION_KEY) → false — auth is per-request (#1983)', () => {
    expect(shouldDefaultClaudeGlobalAuth({ TOKEN_ENCRYPTION_KEY: 'k' })).toBe(false);
  });

  test('explicit install creds → false', () => {
    expect(shouldDefaultClaudeGlobalAuth({ CLAUDE_API_KEY: 'sk' })).toBe(false);
    expect(shouldDefaultClaudeGlobalAuth({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' })).toBe(false);
  });

  test('operator set the var explicitly → never override (either value)', () => {
    expect(shouldDefaultClaudeGlobalAuth({ CLAUDE_USE_GLOBAL_AUTH: 'true' })).toBe(false);
    expect(shouldDefaultClaudeGlobalAuth({ CLAUDE_USE_GLOBAL_AUTH: 'false' })).toBe(false);
  });

  test('empty-string credential is treated as missing', () => {
    expect(shouldDefaultClaudeGlobalAuth({ CLAUDE_API_KEY: '' })).toBe(true);
  });
});

describe('hasClaudeBootAuthPosture', () => {
  test('nothing set → false (server should warn/exit)', () => {
    expect(hasClaudeBootAuthPosture({})).toBe(false);
  });

  test('per-user keys alone is a valid posture (no exit on per-user-only install)', () => {
    expect(hasClaudeBootAuthPosture({ TOKEN_ENCRYPTION_KEY: 'k' })).toBe(true);
  });

  test.each([['CLAUDE_API_KEY'], ['CLAUDE_CODE_OAUTH_TOKEN']])(
    '%s alone is a valid posture',
    key => {
      expect(hasClaudeBootAuthPosture({ [key]: 'x' })).toBe(true);
    }
  );

  test("CLAUDE_USE_GLOBAL_AUTH='true' alone is a valid posture", () => {
    expect(hasClaudeBootAuthPosture({ CLAUDE_USE_GLOBAL_AUTH: 'true' })).toBe(true);
  });

  test("CLAUDE_USE_GLOBAL_AUTH='false' is an explicit opt-out, not a posture", () => {
    expect(hasClaudeBootAuthPosture({ CLAUDE_USE_GLOBAL_AUTH: 'false' })).toBe(false);
    // any non-'true' value is treated as disabled
    expect(hasClaudeBootAuthPosture({ CLAUDE_USE_GLOBAL_AUTH: 'x' })).toBe(false);
  });
});
