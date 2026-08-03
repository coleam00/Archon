/**
 * Slack user authorization utilities
 * Parses and validates Slack user IDs for whitelist-based access control
 */

/**
 * Parse comma-separated Slack user IDs from environment variable
 * Returns empty array if not set or invalid (open access mode)
 */
export function parseAllowedUserIds(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '' && /^[UW][A-Z0-9]+$/.test(id)); // Slack user IDs: U or W prefix + alphanumeric
}

/**
 * Check if a Slack user ID is authorized
 * Returns true if:
 * - allowedIds is empty (open access mode)
 * - userId is in allowedIds
 */
export function isSlackUserAuthorized(userId: string | undefined, allowedIds: string[]): boolean {
  if (allowedIds.length === 0) {
    return true;
  }

  if (userId === undefined || userId.trim() === '') {
    return false;
  }

  return allowedIds.includes(userId);
}
