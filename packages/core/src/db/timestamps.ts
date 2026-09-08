import { getDatabaseType } from './connection';

/**
 * Shared timestamp hydration for rows read from SQLite.
 *
 * SQLite stores every timestamp as TEXT written by `datetime('now')` — UTC,
 * "YYYY-MM-DD HH:MM:SS", no zone marker — which JavaScript parses as LOCAL
 * time, so re-anchor it to UTC before converting. Postgres rows arrive as real
 * Date objects and strings are the only other shape these normalizers see; the
 * regex trusts an already-zoned string and leaves its offset intact.
 *
 * This is the inverse of `toDbTimestampParam` below, which writes a cutoff in
 * the shape each dialect stores (findLatestByCodebaseAndWorkingPath in
 * isolation-environments.ts still inlines the same conversion). Hydrating on
 * read keeps comparisons like `environment.created_at <= run.started_at`
 * (#2747 adoption) UTC-correct on both dialects instead of drifting by the
 * host's UTC offset.
 */
export function toHydratedTimestamp(value: string): Date {
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
  return new Date(zoned ? value : `${value.replace(' ', 'T')}Z`);
}

/**
 * Format a Date for a timestamp comparison param the way each dialect STORES
 * the column it is compared against.
 *
 * SQLite keeps `datetime('now')` text — "YYYY-MM-DD HH:MM:SS" — and compares it
 * lexicographically, so an ISO string sorts wrong (the space at index 10 is
 * below 'T') and a `created_at < cursor` clause would silently match nothing.
 * Postgres has native timestamps and accepts the ISO string.
 */
export function toDbTimestampParam(value: Date): string {
  return getDatabaseType() === 'sqlite'
    ? value.toISOString().replace('T', ' ').slice(0, 19)
    : value.toISOString();
}
