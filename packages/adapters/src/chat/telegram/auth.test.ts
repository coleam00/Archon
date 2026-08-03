/**
 * Unit tests for Telegram authorization utilities
 */
import { parseAllowedUserIds, isUserAuthorized } from './auth';

describe('telegram-auth', () => {
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
      expect(parseAllowedUserIds('123456789')).toEqual([123456789]);
    });

    test('should parse multiple user IDs', () => {
      expect(parseAllowedUserIds('123,456,789')).toEqual([123, 456, 789]);
    });

    test('should handle whitespace around IDs', () => {
      expect(parseAllowedUserIds(' 123 , 456 , 789 ')).toEqual([123, 456, 789]);
    });

    test('should filter out invalid IDs', () => {
      expect(parseAllowedUserIds('123,abc,456')).toEqual([123, 456]);
    });

    test('should filter out negative IDs', () => {
      expect(parseAllowedUserIds('123,-456,789')).toEqual([123, 789]);
    });

    test('should filter out zero', () => {
      expect(parseAllowedUserIds('0,123,456')).toEqual([123, 456]);
    });

    test('should handle empty segments', () => {
      expect(parseAllowedUserIds('123,,456')).toEqual([123, 456]);
    });
  });

  describe('isUserAuthorized', () => {
    describe('open access mode (empty allowedIds)', () => {
      test('should allow any user ID when no whitelist', () => {
        expect(isUserAuthorized(123456, [])).toBe(true);
      });

      test('should allow undefined user ID when no whitelist', () => {
        expect(isUserAuthorized(undefined, [])).toBe(true);
      });
    });

    describe('whitelist mode', () => {
      const allowedIds = [111, 222, 333];

      test('should allow authorized user', () => {
        expect(isUserAuthorized(222, allowedIds)).toBe(true);
      });

      test('should reject unauthorized user', () => {
        expect(isUserAuthorized(999, allowedIds)).toBe(false);
      });

      test('should reject undefined user ID', () => {
        expect(isUserAuthorized(undefined, allowedIds)).toBe(false);
      });
    });
  });
});
