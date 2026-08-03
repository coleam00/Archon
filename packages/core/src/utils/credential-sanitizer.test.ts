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

    // Salvaged from PR #1404 (credit @mlnchk), adapted to the generalized
    // userinfo redaction that preserves the host.
    it('should replace GITLAB_TOKEN value in string', () => {
      process.env.GITLAB_TOKEN = 'glpat-abc123';
      const input = 'fatal: auth failed using token glpat-abc123';
      const result = sanitizeCredentials(input);
      expect(result).not.toContain('glpat-abc123');
      expect(result).toContain('[REDACTED]');
    });

    it('should replace GITEA_TOKEN value in string', () => {
      process.env.GITEA_TOKEN = 'gitea-secret-456';
      const input = 'fatal: auth failed using token gitea-secret-456';
      const result = sanitizeCredentials(input);
      expect(result).not.toContain('gitea-secret-456');
      expect(result).toContain('[REDACTED]');
    });

    it('should sanitize oauth2-style URL credentials on any host', () => {
      process.env.GITLAB_TOKEN = ''; // Clear env token so only URL regex matches
      const input =
        'fatal: clone failed for https://oauth2:glpat-secret@gitlab.example.com/owner/repo.git';
      const result = sanitizeCredentials(input);
      expect(result).not.toContain('glpat-secret');
      expect(result).toContain('https://[REDACTED]@gitlab.example.com/owner/repo.git');
    });

    it('should sanitize bare-token URL credentials on any host', () => {
      const input = 'fatal: unable to access https://gitea-token@gitea.example.com/owner/repo.git';
      const result = sanitizeCredentials(input);
      expect(result).not.toContain('gitea-token');
      expect(result).toBe(
        'fatal: unable to access https://[REDACTED]@gitea.example.com/owner/repo.git'
      );
    });

    it('should not alter URLs without embedded credentials', () => {
      const input =
        'see https://gitlab.example.com/owner/repo and https://example.com/docs/a@b for details';
      expect(sanitizeCredentials(input)).toBe(input);
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
