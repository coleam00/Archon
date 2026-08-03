/**
 * Unit tests for Slack authorization utilities
 */
import { parseAllowedUserIds, isSlackUserAuthorized } from './auth';

describe('slack-auth', () => {
  describe('parseAllowedUserIds', () => {
    test('should return empty array for undefined', () => {
      expect(parseAllowedUserIds(undefined)).toEqual([]);
    });

    test('should return empty array for empty string', () => {
      expect(parseAllowedUserIds('')).toEqual([]);
    });

    test('should return empty array for whitespace-only string', () => {
      expect(parseAllowedUserIds('   ')).toEqual([]);
    });

    test('should parse single user ID', () => {
      expect(parseAllowedUserIds('U1234ABCD')).toEqual(['U1234ABCD']);
    });

    test('should parse multiple user IDs', () => {
      expect(parseAllowedUserIds('U1234ABCD,W5678EFGH')).toEqual(['U1234ABCD', 'W5678EFGH']);
    });

    test('should handle whitespace around IDs', () => {
      expect(parseAllowedUserIds(' U1234ABCD , W5678EFGH ')).toEqual(['U1234ABCD', 'W5678EFGH']);
    });

    test('should filter out invalid IDs', () => {
      expect(parseAllowedUserIds('U1234ABCD,invalid,W5678EFGH')).toEqual([
        'U1234ABCD',
        'W5678EFGH',
      ]);
    });

    test('should handle empty segments', () => {
      expect(parseAllowedUserIds('U1234ABCD,,W5678EFGH')).toEqual(['U1234ABCD', 'W5678EFGH']);
    });
  });

  describe('isSlackUserAuthorized', () => {
    describe('open access mode (empty allowedIds)', () => {
      test('should allow any user ID when no whitelist', () => {
        expect(isSlackUserAuthorized('U1234ABCD', [])).toBe(true);
      });

      test('should allow undefined user ID when no whitelist', () => {
        expect(isSlackUserAuthorized(undefined, [])).toBe(true);
      });
    });

    describe('whitelist mode', () => {
      const allowedIds = ['U1234ABCD', 'W5678EFGH', 'U9999ZZZZ'];

      test('should allow authorized user', () => {
        expect(isSlackUserAuthorized('W5678EFGH', allowedIds)).toBe(true);
      });

      test('should reject unauthorized user', () => {
        expect(isSlackUserAuthorized('UNOTALLOWED', allowedIds)).toBe(false);
      });

      test('should reject undefined user ID', () => {
        expect(isSlackUserAuthorized(undefined, allowedIds)).toBe(false);
      });
    });
  });
});
