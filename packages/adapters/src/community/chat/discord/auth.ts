/**
 * Discord user authorization utilities
 * Parses and validates Discord user IDs for whitelist-based access control
 */

/**
 * Parse comma-separated Discord user IDs from environment variable
 * Returns empty array if not set or invalid (open access mode)
 */
export function parseAllowedUserIds(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '' && /^\d+$/.test(id)); // Discord IDs are numeric strings (snowflakes)
}

/**
 * Check if a Discord user ID is authorized
 * Returns true if:
 * - allowedIds is empty (open access mode)
 * - userId is in allowedIds
 */
export function isDiscordUserAuthorized(userId: string | undefined, allowedIds: string[]): boolean {
  // Open access mode - no whitelist configured
  if (allowedIds.length === 0) {
    return true;
  }

  // No user ID available
  if (userId === undefined || userId.trim() === '') {
    return false;
  }

  return allowedIds.includes(userId);
}
