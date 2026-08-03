/**
 * Gitea user authorization utilities
 * Parses and validates Gitea usernames for whitelist-based access control
 */

/**
 * Parse comma-separated Gitea usernames from environment variable
 * Returns empty array if not set or invalid (open access mode)
 * Normalizes usernames to lowercase for case-insensitive matching
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
 * Check if a Gitea username is authorized
 * Returns true if:
 * - allowedUsers is empty (open access mode)
 * - username (case-insensitive) is in allowedUsers
 */
export function isGiteaUserAuthorized(
  username: string | undefined,
  allowedUsers: string[]
): boolean {
  // Open access mode - no whitelist configured
  if (allowedUsers.length === 0) {
    return true;
  }

  // No username available
  if (username === undefined || username.trim() === '') {
    return false;
  }

  // Case-insensitive comparison
  return allowedUsers.includes(username.toLowerCase());
}
