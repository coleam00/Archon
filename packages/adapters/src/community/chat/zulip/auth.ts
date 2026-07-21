/**
 * Parse comma-separated numeric Zulip user IDs from an env var.
 *
 * - undefined / empty / whitespace -> `[]` (open access; the allowlist is intentionally disabled)
 * - one or more valid numeric IDs   -> the parsed list (allowlist enforced)
 * - set but containing any non-numeric token, or no IDs at all -> throws
 *
 * The throw is deliberate: silently dropping malformed tokens previously let a misconfigured
 * allowlist (e.g. a typo'd ID, or all-invalid entries) collapse to `[]`, which
 * `isZulipUserAuthorized` treats as open access — turning a misconfiguration into fail-OPEN.
 * Failing loudly at startup keeps the allowlist fail-CLOSED.
 */
export function parseAllowedUserIds(envValue: string | undefined): number[] {
  if (!envValue?.trim()) return [];
  const ids = envValue
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => {
      if (!/^\d+$/.test(s)) {
        throw new Error(
          `Invalid ZULIP_ALLOWED_USER_IDS: "${s}" is not a numeric user ID. ` +
            'Provide a comma-separated list of numeric IDs, or unset it for open access.'
        );
      }
      return Number(s);
    });
  if (ids.length === 0) {
    throw new Error(
      'ZULIP_ALLOWED_USER_IDS is set but contains no valid user IDs. ' +
        'Provide a comma-separated list of numeric IDs, or unset it for open access.'
    );
  }
  return ids;
}

/** Returns true if allowedIds is empty (open access) or userId is in the list. */
export function isZulipUserAuthorized(userId: number, allowedIds: number[]): boolean {
  if (allowedIds.length === 0) return true;
  return allowedIds.includes(userId);
}
