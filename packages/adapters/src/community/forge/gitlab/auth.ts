/**
 * GitLab user authorization and webhook token verification utilities
 */
import { timingSafeEqual } from 'crypto';

/**
 * Parse comma-separated GitLab usernames from environment variable.
 * Returns empty array if not set or invalid (open access mode).
 * Normalizes usernames to lowercase for case-insensitive matching.
 */
export function parseAllowedUsers(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(user => user.trim().toLowerCase())
    .filter(user => user !== '');
}

/**
 * Check if a GitLab username is authorized.
 * Returns true if:
 * - allowedUsers is empty (open access mode)
 * - username (case-insensitive) is in allowedUsers
 */
export function isGitLabUserAuthorized(
  username: string | undefined,
  allowedUsers: string[]
): boolean {
  if (allowedUsers.length === 0) {
    return true;
  }

  if (username === undefined || username.trim() === '') {
    return false;
  }

  return allowedUsers.includes(username.toLowerCase());
}

/**
 * Verify GitLab webhook token.
 * GitLab sends the secret as a plain token in the X-Gitlab-Token header (no HMAC).
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyWebhookToken(receivedToken: string, expectedSecret: string): boolean {
  if (!receivedToken || !expectedSecret) return false;
  const receivedBuf = Buffer.from(receivedToken);
  const expectedBuf = Buffer.from(expectedSecret);

  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(receivedBuf, expectedBuf);
}
