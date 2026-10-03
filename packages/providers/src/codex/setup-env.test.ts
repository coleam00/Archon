import { describe, expect, test } from 'bun:test';
import { formatCodexSetupDeprecation, readCodexSetupEnv } from './setup-env';

describe('readCodexSetupEnv', () => {
  test('ARCHON_ names are read, and the user’s own CODEX_ACCESS_TOKEN is left alone', () => {
    const { values, deprecated } = readCodexSetupEnv({
      ARCHON_CODEX_ID_TOKEN: 'new-id',
      ARCHON_CODEX_ACCESS_TOKEN: 'new-access',
      CODEX_ID_TOKEN: 'old-id',
      CODEX_ACCESS_TOKEN: 'users-own-codex-token',
    });
    expect(values).toEqual({ idToken: 'new-id', accessToken: 'new-access' });
    expect(deprecated).toEqual([]);
  });

  test('an old Archon setup is read from the old names and reported as deprecated', () => {
    const { values, deprecated } = readCodexSetupEnv({
      CODEX_ID_TOKEN: 'old-id',
      CODEX_ACCESS_TOKEN: 'old-access',
    });
    expect(values).toEqual({ idToken: 'old-id', accessToken: 'old-access' });
    expect(deprecated.map(v => v.legacy)).toEqual(['CODEX_ID_TOKEN', 'CODEX_ACCESS_TOKEN']);
  });

  test('a lone CODEX_ACCESS_TOKEN is the user’s Codex auth, not a deprecated Archon setup', () => {
    expect(readCodexSetupEnv({ CODEX_ACCESS_TOKEN: 'users-own-codex-token' })).toEqual({
      values: {},
      deprecated: [],
    });
  });

  test('the deprecation warning names both variables and never a value', () => {
    const { deprecated } = readCodexSetupEnv({
      CODEX_ID_TOKEN: 'id-secret-value',
      CODEX_REFRESH_TOKEN: 'rt_secret-value',
    });
    const message = formatCodexSetupDeprecation(deprecated);
    expect(message).toContain('CODEX_REFRESH_TOKEN -> ARCHON_CODEX_REFRESH_TOKEN');
    expect(message).not.toContain('secret-value');
  });
});
