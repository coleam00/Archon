/** Parse comma-separated numeric Zulip user IDs from env var. Returns [] for open access. */
export function parseAllowedUserIds(envValue: string | undefined): number[] {
  if (!envValue?.trim()) return [];
  return envValue
    .split(',')
    .map(s => s.trim())
    .filter(s => /^\d+$/.test(s))
    .map(Number);
}

/** Returns true if allowedIds is empty (open access) or userId is in the list. */
export function isZulipUserAuthorized(userId: number, allowedIds: number[]): boolean {
  if (allowedIds.length === 0) return true;
  return allowedIds.includes(userId);
}
