/**
 * Telegram user authorization utilities
 * Parses and validates user IDs for whitelist-based access control
 */

/**
 * Parse comma-separated user IDs from environment variable
 * Returns empty array if not set or invalid (open access mode)
 */
export function parseAllowedUserIds(envValue: string | undefined): number[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '')
    .map(id => parseInt(id, 10))
    .filter(id => !isNaN(id) && id > 0);
}

/**
 * Check if a user ID is authorized
 * Returns true if:
 * - allowedIds is empty (open access mode)
 * - userId is in allowedIds
 */
export function isUserAuthorized(userId: number | undefined, allowedIds: number[]): boolean {
  // Open access mode - no whitelist configured
  if (allowedIds.length === 0) {
    return true;
  }

  // No user ID available (should not happen in normal Telegram flow)
  if (userId === undefined) {
    return false;
  }

  return allowedIds.includes(userId);
}
