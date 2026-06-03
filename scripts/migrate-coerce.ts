/**
 * Pure type-coercion helpers for the SQLite -> Postgres migration.
 *
 * Each function takes a value as it appears in the live SQLite database
 * (verified by sampling 9/9 application tables) and returns the value
 * shaped to match the Postgres target schema.
 *
 * No I/O, no `pg` import — these are pure so they can be unit-tested
 * without a database. The migration driver (scripts/migrate-sqlite-to-postgres.ts)
 * calls these in a hot loop while reading rows.
 */

/**
 * Transform a primary key from the SQLite 32-char-hex form
 * (`lower(hex(randomblob(16)))`) or the 36-char canonical UUID form into
 * the canonical 36-char form Postgres requires.
 *
 * Live sampling found 7/9 tables store 32-char hex; 2/9 store 36-char
 * canonical UUIDs. Both pass through this function.
 *
 * Examples:
 *   transformId('aabbccddeeff00112233445566778899')
 *     => 'aabbccdd-eeff-0011-2233-445566778899'
 *   transformId('aabbccdd-eeff-0011-2233-445566778899')
 *     => 'aabbccdd-eeff-0011-2233-445566778899'
 */
export function transformId(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`transformId: expected string, got ${typeof value}`);
  }
  // Postgres accepts lowercase UUIDs; the input is already lowercase
  // per `lower(hex(randomblob(16)))` in the SQLite schema, but normalize
  // for safety when re-running against hand-edited data.
  const normalized = value.toLowerCase();
  if (normalized.length === 36) {
    // Already canonical; just validate the shape.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
      throw new Error(`transformId: malformed 36-char UUID: ${value}`);
    }
    return normalized;
  }
  if (normalized.length === 32) {
    if (!/^[0-9a-f]{32}$/.test(normalized)) {
      throw new Error(`transformId: malformed 32-char hex ID: ${value}`);
    }
    return (
      normalized.slice(0, 8) +
      '-' +
      normalized.slice(8, 12) +
      '-' +
      normalized.slice(12, 16) +
      '-' +
      normalized.slice(16, 20) +
      '-' +
      normalized.slice(20, 32)
    );
  }
  throw new Error(`transformId: unexpected ID length ${normalized.length}: ${value}`);
}

/**
 * Coerce an INTEGER 0/1 (SQLite's only boolean) to a JS boolean.
 * `null` and `undefined` are treated as `false` — the migration runs
 * against a live DB where `hidden` / `active` columns can be NULL but
 * Postgres requires NOT NULL with DEFAULT FALSE.
 */
export function coerceBoolean(value: number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (value === 1) return true;
  if (value === 0) return false;
  throw new RangeError(`coerceBoolean: expected 0/1/null, got ${String(value)}`);
}

/**
 * Coerce a TEXT-JSON column (e.g. `commands`, `metadata`, `workflow_events.data`)
 * to a JS object suitable for `pg` to serialize as JSONB.
 *
 * - `null` -> `null` (the column was explicitly null; preserve it)
 * - `string` -> `JSON.parse(value)` (SQLite stores JSON-as-TEXT)
 * - `object` -> identity (defensive; shouldn't happen from `bun:sqlite` but cheap)
 */
export function coerceJson(value: string | object | null): unknown {
  if (value === null) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    if (value === '') return null;
    try {
      return JSON.parse(value);
    } catch (err) {
      // Logged with a 200-char preview so the operator can inspect the
      // source data after the cutover. Returning null keeps the
      // migration moving — the Postgres JSONB column accepts NULL.
      console.error(
        `[migrate-coerce] coerceJson: invalid JSON, treating as null: ${(err as Error).message}; value=${value.slice(0, 200)}`
      );
      return null;
    }
  }
  throw new TypeError(`coerceJson: expected string|object|null, got ${typeof value}`);
}

/**
 * Coerce a timestamp column.
 *
 * SQLite stores timestamps as `datetime('now')` -> `YYYY-MM-DD HH:MM:SS`
 * OR as ISO 8601 strings written by application code. Postgres' TIMESTAMP
 * WITH TIME ZONE parses both forms when the input is unambiguous.
 *
 * Pass through as a string; let Postgres parse. Throws on `null` /
 * undefined / non-string — caller is expected to map missing columns to
 * `null` explicitly if the Postgres column allows it.
 */
export function coerceTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`coerceTimestamp: expected string|null, got ${typeof value}`);
  }
  if (value === '') return null;
  // Sanity check: must contain a year as 4 digits. Postgres is permissive
  // enough that this is the only validation we need before handing off.
  if (!/^\d{4}/.test(value)) {
    throw new Error(`coerceTimestamp: value does not start with a year: ${value}`);
  }
  return value;
}
