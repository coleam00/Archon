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
