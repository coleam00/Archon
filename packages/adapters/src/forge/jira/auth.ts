/**
 * Jira user authorization + webhook-secret verification utilities.
 *
 * Mirrors the GitHub adapter's auth helpers. Jira Cloud webhooks have no
 * built-in HMAC signature, so we authenticate the webhook via a shared secret
 * passed as the `?secret=` query parameter and compared in constant time.
 */
import { timingSafeEqual } from 'crypto';

/**
 * Parse a comma-separated allowlist of Jira identifiers (accountIds or emails)
 * from an environment variable. Empty/unset → open access (empty array).
 * Values are lowercased for case-insensitive matching (emails); accountIds are
 * already case-stable, so lowercasing is harmless.
 */
export function parseJiraAllowedUsers(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(user => user.trim().toLowerCase())
    .filter(user => user !== '');
}

/**
 * Authorize a comment author against the allowlist.
 *
 * The author may be identified by accountId and/or email; either matching an
 * entry authorizes the request. Returns true when:
 * - allowedUsers is empty (open access), OR
 * - accountId (case-insensitive) is in allowedUsers, OR
 * - email (case-insensitive) is in allowedUsers
 */
export function isJiraUserAuthorized(
  identity: { accountId?: string; email?: string },
  allowedUsers: string[]
): boolean {
  // Open access mode - no allowlist configured
  if (allowedUsers.length === 0) {
    return true;
  }

  const accountId = identity.accountId?.trim().toLowerCase();
  const email = identity.email?.trim().toLowerCase();

  if (accountId && allowedUsers.includes(accountId)) return true;
  if (email && allowedUsers.includes(email)) return true;

  return false;
}

/**
 * Constant-time comparison of the received webhook secret against the
 * configured one. Returns false on any length mismatch (checked before the
 * timing-safe compare, since timingSafeEqual throws on unequal lengths) or
 * when either value is missing.
 */
export function timingSafeCompareSecret(
  received: string | undefined,
  expected: string | undefined
): boolean {
  if (!received || !expected) return false;

  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
