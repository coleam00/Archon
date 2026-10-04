import { describe, expect, test } from 'bun:test';
import { readCodexBootAuth } from './codex-auth-posture';

describe('readCodexBootAuth', () => {
  test('the new names count as Codex credentials', () => {
    expect(
      readCodexBootAuth({ ARCHON_CODEX_ID_TOKEN: 'id', ARCHON_CODEX_ACCESS_TOKEN: 'access' })
    ).toEqual({ hasCredentials: true, deprecated: [] });
  });

  test('an old Archon setup still boots this release, and is reported', () => {
    const auth = readCodexBootAuth({ CODEX_ID_TOKEN: 'id', CODEX_ACCESS_TOKEN: 'access' });
    expect(auth.hasCredentials).toBe(true);
    expect(auth.deprecated.map(v => v.legacy)).toEqual(['CODEX_ID_TOKEN', 'CODEX_ACCESS_TOKEN']);
  });

  test('a lone CODEX_ACCESS_TOKEN is the user’s Codex auth, not Archon setup credentials', () => {
    expect(readCodexBootAuth({ CODEX_ACCESS_TOKEN: 'users-own' })).toEqual({
      hasCredentials: false,
      deprecated: [],
    });
  });
});
