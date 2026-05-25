/**
 * Unit tests for Zulip authorization utilities
 */
import { describe, test, expect } from 'bun:test';
import { parseAllowedUserIds, isZulipUserAuthorized } from './auth';

describe('zulip-auth', () => {
  describe('parseAllowedUserIds', () => {
    test('should return empty array for undefined (open access)', () => {
      expect(parseAllowedUserIds(undefined)).toEqual([]);
    });

    test('should return empty array for empty string (open access)', () => {
      expect(parseAllowedUserIds('')).toEqual([]);
    });

    test('should return empty array for whitespace-only string (open access)', () => {
      expect(parseAllowedUserIds('   ')).toEqual([]);
    });

    test('should parse a single numeric user ID', () => {
      expect(parseAllowedUserIds('123456789')).toEqual([123456789]);
    });

    test('should parse multiple numeric user IDs', () => {
      expect(parseAllowedUserIds('111,222,333')).toEqual([111, 222, 333]);
    });

    test('should trim whitespace around IDs', () => {
      expect(parseAllowedUserIds(' 111 , 222 , 333 ')).toEqual([111, 222, 333]);
    });

    test('should ignore empty segments between valid IDs', () => {
      expect(parseAllowedUserIds('111,,222')).toEqual([111, 222]);
    });

    // Fail-CLOSED: a set-but-malformed allowlist must not collapse to open access.
    test('should throw when a token is non-numeric', () => {
      expect(() => parseAllowedUserIds('111,abc,222')).toThrow(/ZULIP_ALLOWED_USER_IDS/);
    });

    test('should throw when set but no valid IDs are present', () => {
      expect(() => parseAllowedUserIds('abc')).toThrow(/ZULIP_ALLOWED_USER_IDS/);
    });

    test('should throw when set to only separators', () => {
      expect(() => parseAllowedUserIds(',,,')).toThrow(/no valid user IDs/);
    });
  });

  describe('isZulipUserAuthorized', () => {
    describe('open access mode (empty allowedIds)', () => {
      test('should allow any user when no whitelist', () => {
        expect(isZulipUserAuthorized(123456, [])).toBe(true);
      });
    });

    describe('whitelist mode', () => {
      const allowedIds = [111, 222, 333];

      test('should allow an authorized user', () => {
        expect(isZulipUserAuthorized(222, allowedIds)).toBe(true);
      });

      test('should reject an unauthorized user', () => {
        expect(isZulipUserAuthorized(999, allowedIds)).toBe(false);
      });
    });
  });
});
