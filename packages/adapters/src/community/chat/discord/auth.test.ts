/**
 * Unit tests for Discord authorization utilities
 */
import { describe, test, expect } from 'bun:test';
import { parseAllowedUserIds, isDiscordUserAuthorized } from './auth';

describe('discord-auth', () => {
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
      expect(parseAllowedUserIds('123456789')).toEqual(['123456789']);
    });

    test('should parse multiple user IDs', () => {
      expect(parseAllowedUserIds('111,222,333')).toEqual(['111', '222', '333']);
    });

    test('should handle whitespace around IDs', () => {
      expect(parseAllowedUserIds(' 111 , 222 , 333 ')).toEqual(['111', '222', '333']);
    });

    test('should filter out non-numeric IDs', () => {
      expect(parseAllowedUserIds('111,abc,222')).toEqual(['111', '222']);
    });

    test('should handle empty segments', () => {
      expect(parseAllowedUserIds('111,,222')).toEqual(['111', '222']);
    });
  });

  describe('isDiscordUserAuthorized', () => {
    describe('open access mode (empty allowedIds)', () => {
      test('should allow any user ID when no whitelist', () => {
        expect(isDiscordUserAuthorized('123456', [])).toBe(true);
      });

      test('should allow undefined user ID when no whitelist', () => {
        expect(isDiscordUserAuthorized(undefined, [])).toBe(true);
      });
    });

    describe('whitelist mode', () => {
      const allowedIds = ['111', '222', '333'];

      test('should allow authorized user', () => {
        expect(isDiscordUserAuthorized('222', allowedIds)).toBe(true);
      });

      test('should reject unauthorized user', () => {
        expect(isDiscordUserAuthorized('999', allowedIds)).toBe(false);
      });

      test('should reject undefined user ID', () => {
        expect(isDiscordUserAuthorized(undefined, allowedIds)).toBe(false);
      });

      test('should reject empty string user ID', () => {
        expect(isDiscordUserAuthorized('', allowedIds)).toBe(false);
      });

      test('should reject whitespace-only user ID', () => {
        expect(isDiscordUserAuthorized('   ', allowedIds)).toBe(false);
      });
    });
  });
});
