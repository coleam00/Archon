/**
 * The arithmetic of a binding's start limit on one item (`limit` on a binding). Admission
 * and the item read both call `startLimitStanding`, so what a stage reads it has left is
 * what admission will allow.
 *
 * The count is derived from the item's start requests, never kept as a counter. A request
 * a limited binding made records the limit it counted under; a request a granting binding
 * made records the name of the limit it raised. The count runs `since` the limit's last
 * reset: the latest completion of its `resetOn` workflow on the item, which the store
 * also records apart from the run row so run cleanup cannot undo it.
 *
 * A queued start always counts: it is a start already promised, and the queue admits it
 * later without asking again, whenever that is. An admitted start or grant counts when it
 * was admitted at or after `since`, so a start that waited in the queue across a reset
 * counts in the new count once it runs. Times compare at the store's precision; SQLite
 * keeps whole seconds, so a start admitted in the same second as a reset counts after it,
 * which can refuse one start early but never lets one through late.
 */
import { z } from 'zod';
import { startLimitSchema, type StartLimit } from './schemas/resource-start';

/**
 * The limit a start request counted under, as stored. More than one binary version reads
 * it, so unknown keys are stripped, never refused.
 */
export const storedStartLimitSchema = z.object(startLimitSchema.shape);

/** One start request on the item, as the count reads it. */
export interface StartLimitRow {
  status: 'queued' | 'admitted' | 'skipped' | 'withdrawn';
  /** When the request was admitted (ISO), or null while it was not. */
  admittedAt: string | null;
  counted: StartLimit | null;
  /** The name of the limit this start raised, or null. */
  grant: string | null;
}

/**
 * A limit's standing on one item. `allowed` is `starts` plus `granted`; `left` is how many
 * more starts admission allows now. `since` is the last reset: when a run of `resetOn` last
 * completed on the item, or null when the count has never reset.
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

function admittedSince(row: StartLimitRow, since: string | null): boolean {
  if (row.status !== 'admitted' || row.admittedAt === null) return false;
  return since === null || Date.parse(row.admittedAt) >= Date.parse(since);
}

/** Where `limit` stands on an item with start requests `rows`, counting since `since`. */
export function startLimitStanding(
  limit: StartLimit,
  rows: readonly StartLimitRow[],
  since: string | null
): StartLimitStanding {
  const used = rows.filter(
    row =>
      row.counted?.name === limit.name && (row.status === 'queued' || admittedSince(row, since))
  ).length;
  const granted = rows.filter(row => row.grant === limit.name && admittedSince(row, since)).length;
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
  const since =
    standing.since === null
      ? ''
      : ` since '${standing.resetOn ?? 'the reset'}' last completed at ${standing.since}`;
  return `Start limit '${standing.name}' reached on item '${itemKey}': ${String(standing.used)} of ${String(allowed)} starts used${since}. An asks-settled binding that grants '${standing.name}' allows one more.`;
}
