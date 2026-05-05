import { describe, test, expect } from 'bun:test';
import { isMattermostUserAuthorized, parseAllowedUserIds } from './auth';

describe('mattermost-auth', () => {
  describe('parseAllowedUserIds', () => {
    test('returns empty array for undefined', () => {
      expect(parseAllowedUserIds(undefined)).toEqual([]);
    });

    test('parses multiple user IDs', () => {
      expect(parseAllowedUserIds('user123, user456')).toEqual(['user123', 'user456']);
    });

    test('filters invalid IDs', () => {
      expect(parseAllowedUserIds('user123, bad-id!, user456')).toEqual(['user123', 'user456']);
    });
  });

  describe('isMattermostUserAuthorized', () => {
    test('allows any user when whitelist is empty', () => {
      expect(isMattermostUserAuthorized('user123', [])).toBe(true);
    });

    test('allows authorized user in whitelist mode', () => {
      expect(isMattermostUserAuthorized('user123', ['user123', 'user456'])).toBe(true);
    });

    test('rejects unauthorized user in whitelist mode', () => {
      expect(isMattermostUserAuthorized('user789', ['user123', 'user456'])).toBe(false);
    });
  });
});
