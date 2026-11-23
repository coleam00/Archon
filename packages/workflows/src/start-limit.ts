/**
 * The arithmetic of a binding's start limit on one item (`limit` on a binding). Admission
 * and the item read both call `startLimitStanding`, so what a stage reads it has left is
 * what admission will allow.
 *
 * The count is derived from the item's start requests, never kept as a counter. A request
 * a limited binding made records the limit it counted under (`StartLimitRecord`); a
 * request a granting binding made records the limit it raised (`StartLimitGrantRecord`).
 * Each records the window it was made in: the completion time of the limit's `resetOn`
 * run on the item when the request was written, or null before any. The current window
 * is the latest of the newest such completion and every window a request recorded, so
 * deleting the reset run (old runs are cleaned up) never brings earlier rounds back. A
 * request counts only in the window it recorded, which keeps the count off clock
 * comparisons between rows written at second precision.
 */
import { z } from 'zod';
import { startLimitSchema, type StartLimit } from './schemas/resource-start';

/**
 * What a limited start request records. Stored as JSON that more than one binary version
 * reads, so unknown keys are stripped, never refused.
 */
export const startLimitRecordSchema = z.object({
  ...startLimitSchema.shape,
  window: z.string().nullable(),
});
export type StartLimitRecord = z.infer<typeof startLimitRecordSchema>;

/** What a granting start request records: the limit it raised and the window it raised it in. */
export const startLimitGrantRecordSchema = z.object({
  name: z.string().min(1),
  window: z.string().nullable(),
});
export type StartLimitGrantRecord = z.infer<typeof startLimitGrantRecordSchema>;

/** One start request on the item, as the count reads it. */
export interface StartLimitRow {
  status: 'queued' | 'admitted' | 'skipped' | 'withdrawn';
  counted: StartLimitRecord | null;
  grant: StartLimitGrantRecord | null;
}

/**
 * A limit's standing on one item. `allowed` is `starts` plus `granted`; `left` is how many
 * more starts admission allows now. `since` is the window the count is in: when a run of
 * `resetOn` last completed on the item, or null when the count has never reset.
 */
export const startLimitStandingSchema = z.object({
  name: z.string(),
  starts: z.number().int().positive(),
  resetOn: z.string().nullable(),
  since: z.string().nullable(),
  granted: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  left: z.number().int().nonnegative(),
});
export type StartLimitStanding = z.infer<typeof startLimitStandingSchema>;

function sameWindow(a: string | null, b: string | null): boolean {
  return a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** The window limit `name` counts in now; see the module comment. */
export function startLimitWindow(
  name: string,
  rows: readonly StartLimitRow[],
  resetCompletedAt: string | null
): string | null {
  let window = resetCompletedAt;
  for (const row of rows) {
    if (row.counted?.name === name) window = later(window, row.counted.window);
    if (row.grant?.name === name) window = later(window, row.grant.window);
  }
  return window;
}

/**
 * Where `limit` stands on an item with start requests `rows`. A queued start counts: it is
 * a start already promised, and the queue admits it without asking again. A grant counts
 * once its start is admitted.
 */
export function startLimitStanding(
  limit: StartLimit,
  rows: readonly StartLimitRow[],
  resetCompletedAt: string | null
): StartLimitStanding {
  const since = startLimitWindow(limit.name, rows, resetCompletedAt);
  const used = rows.filter(
    row =>
      row.counted?.name === limit.name &&
      sameWindow(row.counted.window, since) &&
      (row.status === 'admitted' || row.status === 'queued')
  ).length;
  const granted = rows.filter(
    row =>
      row.grant?.name === limit.name &&
      sameWindow(row.grant.window, since) &&
      row.status === 'admitted'
  ).length;
  return {
    name: limit.name,
    starts: limit.starts,
    resetOn: limit.resetOn ?? null,
    since,
    granted,
    used,
    left: Math.max(0, limit.starts + granted - used),
  };
}

/** Why admission refused a start at its limit, written where `trigger inspect` shows it. */
export function startLimitRefusal(standing: StartLimitStanding, itemKey: string): string {
  const allowed = standing.starts + standing.granted;
  const window =
    standing.since === null
      ? ''
      : ` since '${standing.resetOn ?? 'the reset'}' last completed at ${standing.since}`;
  return `Start limit '${standing.name}' reached on item '${itemKey}': ${String(standing.used)} of ${String(allowed)} starts used${window}. An asks-settled binding that grants '${standing.name}' allows one more.`;
}
