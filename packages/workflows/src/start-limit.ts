/**
 * The arithmetic of a binding's start limit on one item (`limit` on a binding). Admission
 * and the item read both call `startLimitStanding`, so what a stage reads it has left is
 * what admission will allow.
 *
 * The count is derived from the item's start requests, never kept as a counter. A request
 * a limited binding made records the limit it counted under; a request a granting binding
 * made records the name of the limit it raised. The count runs from the limit's last reset
 * (`StartLimitReset`), the latest completion of its `resetOn` workflow on the item, which
 * the store records in event order: a request is after the reset when its queue position
 * is above the reset's, or when it was still waiting in the queue at the reset, and so runs
 * after it. Time is not compared, so a start and a reset in the same second still order.
 *
 * Queued and admitted starts count; a queued start is a start already promised, and the
 * queue admits it later without asking again. A grant counts once its start is admitted.
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
  id: string;
  /** The request's queue position: the order requests were written in. */
  position: number;
  status: 'queued' | 'admitted' | 'skipped' | 'withdrawn';
  /**
   * True for an admitted request whose run ended without ever being claimed: cancelled or
   * failed while still pending, so the start it counted never ran.
   */
  endedUnstarted: boolean;
  counted: StartLimit | null;
  /** The name of the limit this start raised, or null. */
  grant: string | null;
}

/**
 * A reset of a limit on an item: when its workflow completed (`at`, for display), the
 * highest request queue position written before it, and the item's limit requests still
 * queued then.
 */
export interface StartLimitReset {
  at: string;
  afterPosition: number;
  queuedIds: readonly string[];
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

function afterReset(row: StartLimitRow, reset: StartLimitReset | null): boolean {
  return reset === null || row.position > reset.afterPosition || reset.queuedIds.includes(row.id);
}

/** Where `limit` stands on an item with start requests `rows`, counting from `reset`. */
export function startLimitStanding(
  limit: StartLimit,
  rows: readonly StartLimitRow[],
  reset: StartLimitReset | null
): StartLimitStanding {
  // A start counts while it is queued, or admitted with a run that is live or was claimed.
  const used = rows.filter(
    row =>
      row.counted?.name === limit.name &&
      (row.status === 'queued' || (row.status === 'admitted' && !row.endedUnstarted)) &&
      afterReset(row, reset)
  ).length;
  const granted = rows.filter(
    row => row.grant === limit.name && row.status === 'admitted' && afterReset(row, reset)
  ).length;
  return {
    name: limit.name,
    starts: limit.starts,
    resetOn: limit.resetOn ?? null,
    since: reset?.at ?? null,
    granted,
    used,
    left: Math.max(0, limit.starts + granted - used),
  };
}

/**
 * A trigger file on this install whose binding counts its starts under a start limit: its
 * `bindingId`, the `workflow` it starts and, for a run-ended binding, the run end that
 * starts it (`runEnded`, null for any other form).
 */
export const startLimitBindingSchema = z.object({
  bindingId: z.string(),
  workflow: z.string(),
  runEnded: z.object({ workflowName: z.string(), outcome: z.string() }).nullable(),
});
export type StartLimitBinding = z.infer<typeof startLimitBindingSchema>;

/**
 * A start limit on the item, as `startLimitStanding` counts it, with the trigger files
 * that count under it. `bindings` is null when the host reads no trigger files or they
 * did not read; an empty list means no file on this install names the limit any more.
 */
export const itemStartLimitSchema = startLimitStandingSchema.extend({
  bindings: z.array(startLimitBindingSchema).nullable(),
});

/**
 * What an item read's host gives to name each limit's `bindings`: this install's trigger
 * files that declare a start limit, each with the limit's name, or null when they did not
 * read. A host without one names none.
 */
export type LimitBindingsReader = () => Promise<
  readonly (StartLimitBinding & { limit: string })[] | null
>;

/** Each limit with the trigger files that count under it; read only when there is a limit. */
export async function withLimitBindings(
  limits: readonly StartLimitStanding[],
  read: LimitBindingsReader | undefined
): Promise<z.infer<typeof itemStartLimitSchema>[]> {
  const files = limits.length === 0 ? null : ((await read?.()) ?? null);
  return limits.map(limit => ({
    ...limit,
    bindings:
      files === null
        ? null
        : files
            .filter(file => file.limit === limit.name)
            .map(({ bindingId, workflow, runEnded }) => ({ bindingId, workflow, runEnded })),
  }));
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
