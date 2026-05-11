import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { sanitizeCredentials, sanitizeError } from './credential-sanitizer';

describe('credential-sanitizer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, GH_TOKEN: 'ghp_test123456789' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('sanitizeCredentials', () => {
    it('should replace GH_TOKEN in string', () => {
      const input = 'fatal: https://ghp_test123456789@github.com/user/repo';
      const result = sanitizeCredentials(input);
      expect(result).not.toContain('ghp_test123456789');
      expect(result).toContain('[REDACTED]');
    });

    it('should handle strings without credentials', () => {
      const input = 'Normal error message';
      expect(sanitizeCredentials(input)).toBe(input);
    });

    it('should sanitize URL pattern as fallback', () => {
      process.env.GH_TOKEN = ''; // Clear token
      const input = 'https://unknown_token@github.com/user/repo';
      expect(sanitizeCredentials(input)).toBe('https://[REDACTED]@github.com/user/repo');
    });
  });

  describe('sanitizeError', () => {
    it('should return new Error with sanitized message', () => {
      const original = new Error('Failed with ghp_test123456789');
      const sanitized = sanitizeError(original);
      expect(sanitized.message).toBe('Failed with [REDACTED]');
    });
  });
});
