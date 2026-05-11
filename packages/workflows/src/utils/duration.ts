/**
 * Parse a timestamp value that may be either a Date (PG driver) or a string
 * (SQLite returns datetimes as strings without timezone). SQLite's CURRENT_TIMESTAMP
 * stores UTC but the returned string has no `Z` suffix, so plain `new Date(str)`
 * would parse it as local time — appearing hours off depending on the user's TZ.
 *
 * Returns ms since epoch.
 */
export function parseDbTimestamp(value: Date | string): number {
  if (value instanceof Date) return value.getTime();
  // Heuristic: if the string already encodes a timezone (Z, +HH:MM, -HH:MM
  // after the time portion), trust it. Otherwise treat as UTC.
  const hasTimezone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
  return new Date(hasTimezone ? value : `${value.replace(' ', 'T')}Z`).getTime();
}

/**
 * Format a millisecond duration as a short human-readable string.
 *
 * Examples:
 *   500 → "1s" (sub-second rounded up to avoid showing "0s")
 *   1500 → "1s"
 *   65000 → "1m 5s"
 *   3700000 → "1h 1m"
 *
 * Negative values are clamped to 0 ("0s"). Designed for UI display, not
 * precise time deltas — drops sub-second precision and seconds at the
 * hour-level.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';

  // Round sub-second (including ms === 0 — treated as a just-started run
  // rather than literal zero) up to 1s so an active run never displays "0s".
  const totalSeconds = Math.max(1, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(hours)}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(minutes)}m`;
  }
  return `${String(seconds)}s`;
}
