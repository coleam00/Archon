import { z } from '@hono/zod-openapi';
import type { TokenUsage } from '@archon/providers/types';

/**
 * Fan-out child outcome observability (#2451).
 *
 * A `join: all_done` fan-out treats child failures as DATA, not as a node failure — which
 * is correct, but the only durable record used to be a JSON array in `$node.output`, so the
 * console painted a partly-failed fan-out green. This module makes never-ran / failed /
 * cancelled child slots visible WITHOUT failing the parent node and WITHOUT a threshold join.
 *
 * Two layers, deliberately split:
 *
 *  - {@link ChildWorkflowOutcome} — the EXECUTION type a `workflow:` node reduces over. A
 *    two-variant union (`ran` / `never_ran`) so an empty-string `childRunId` is
 *    unrepresentable — a slot that never produced a run row has no id at all. Join reducers
 *    keep switching on `status` after narrowing `kind === 'ran'`.
 *
 *  - {@link ChildDisposition} — the WIRE record persisted on `node_completed` /
 *    `node_failed` (`data.fan_out = { children }`). Five variants covering every way a slot
 *    can settle. The tally is DERIVED at parse via {@link tallyChildDispositions} (one
 *    exhaustive `switch`), never stored — a sixth variant is a compile error, not a stale
 *    JSON field.
 *
 * `$node.output` (the aggregate array consumed by `$spread.output`) is unchanged; this is a
 * second, separate key. {@link toFanOutView} is the read-time DTO the HTTP API attaches as
 * `fan_out_view`: structured `{ children, tally, overflowCount }`, not pre-rendered strings.
 */

/** Max length for error/reason excerpts persisted on the wire. The full error stays on the
 *  child run row when a row exists; a `never_ran` slot has no row, so its `error` is the
 *  only copy — still bounded here to keep the event payload small. */
export const FAN_OUT_EXCERPT_MAX_CHARS = 240;

/** Max indexed non-completed child lines the CLI (and console) print before `+N more`. */
export const FAN_OUT_ATTENTION_LINE_CAP = 20;

/** Max child dispositions persisted on `data.fan_out`. Non-completed slots are kept first. */
export const FAN_OUT_CHILDREN_MAX = 500;

/** Truncate a wire-bound error/reason string to a bounded excerpt (`…` suffix when cut). */
export function fanOutExcerpt(text: string, max = FAN_OUT_EXCERPT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Why a fan-out slot never produced a run row:
 *  - `unresolved_target` — the `workflow:` name did not resolve (typo / unknown workflow).
 *  - `blocked_before_spawn` — a guard fired before the row existed (cycle, depth cap, bad
 *    `with:` contract, isolation-resolver failure, create failure).
 *  - `slot_threw` — the concurrency slot rejected outright (a defensive, should-not-happen
 *    path, recorded rather than swallowed).
 */
export const childNeverRanReasonSchema = z.enum([
  'unresolved_target',
  'blocked_before_spawn',
  'slot_threw',
]);
export type ChildNeverRanReason = z.infer<typeof childNeverRanReasonSchema>;

/**
 * `cancelled_reason` values the fan-out path stamps on children it cancels ITSELF (so the
 * cancel is attributable and engine-owned). Mirrors `FanOutCancelReason` in dag-executor —
 * kept here so {@link toChildDisposition} can classify an engine cancel without importing the
 * executor. `fan_out_sibling` is read-only legacy (nothing writes it any more; see the
 * dag-executor note).
 */
export const fanOutEngineCancelReasonSchema = z.enum([
  'fan_out_gate',
  'fan_out_orphan',
  'fan_out_sibling',
]);
export type FanOutEngineCancelReason = z.infer<typeof fanOutEngineCancelReasonSchema>;

const childIndexSchema = z.number().int().nonnegative();

/**
 * One fan-out slot's persisted disposition (the wire record). Discriminated on `kind`.
 * Ordered by index in the `children` array. When the item list exceeds
 * {@link FAN_OUT_CHILDREN_MAX}, non-completed slots are kept first and `overflowCount`
 * records how many slots were omitted (typically completed ones).
 */
export const childDispositionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('completed'),
    index: childIndexSchema,
    childRunId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('failed'),
    index: childIndexSchema,
    childRunId: z.string().min(1),
    error: z.string(),
  }),
  z.object({
    kind: z.literal('cancelled_by_engine'),
    index: childIndexSchema,
    childRunId: z.string().min(1),
    reason: fanOutEngineCancelReasonSchema,
  }),
  z.object({
    kind: z.literal('cancelled_out_of_band'),
    index: childIndexSchema,
    childRunId: z.string().min(1),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal('never_ran'),
    index: childIndexSchema,
    reason: childNeverRanReasonSchema,
    error: z.string(),
  }),
]);
export type ChildDisposition = z.infer<typeof childDispositionSchema>;

/**
 * The persisted payload of `data.fan_out`. `{ children }` is stored; `overflowCount` is
 * present only when the item list exceeded {@link FAN_OUT_CHILDREN_MAX}. The tally is derived
 * at parse (omitted completed slots are added back via `overflowCount`).
 */
export const fanOutReportPayloadSchema = z.object({
  children: z.array(childDispositionSchema).max(FAN_OUT_CHILDREN_MAX),
  overflowCount: z.number().int().nonnegative().optional(),
});
export type FanOutReportPayload = z.infer<typeof fanOutReportPayloadSchema>;

/** Derived counts over a fan-out's dispositions. Never stored — computed at parse. */
export const fanOutTallySchema = z.object({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelledByEngine: z.number().int().nonnegative(),
  cancelledOutOfBand: z.number().int().nonnegative(),
  neverRan: z.number().int().nonnegative(),
  /** `total - completed` — every slot that did not reach `completed`. */
  notCompleted: z.number().int().nonnegative(),
});
export type FanOutTally = z.infer<typeof fanOutTallySchema>;

/**
 * Derive the tally from the ordered dispositions. The `switch` is exhaustive on `kind`; a
 * sixth `ChildDisposition` variant makes the `never` assignment a compile error rather than a
 * silently-uncounted slot.
 */
export function tallyChildDispositions(children: readonly ChildDisposition[]): FanOutTally {
  const tally: FanOutTally = {
    total: children.length,
    completed: 0,
    failed: 0,
    cancelledByEngine: 0,
    cancelledOutOfBand: 0,
    neverRan: 0,
    notCompleted: 0,
  };
  for (const child of children) {
    switch (child.kind) {
      case 'completed':
        tally.completed += 1;
        break;
      case 'failed':
        tally.failed += 1;
        break;
      case 'cancelled_by_engine':
        tally.cancelledByEngine += 1;
        break;
      case 'cancelled_out_of_band':
        tally.cancelledOutOfBand += 1;
        break;
      case 'never_ran':
        tally.neverRan += 1;
        break;
      default: {
        const exhaustiveCheck: never = child;
        throw new Error(`Unhandled child disposition: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }
  tally.notCompleted = tally.total - tally.completed;
  return tally;
}

/** A parsed fan-out report: the persisted children plus the derived tally. */
export interface FanOutReport {
  children: ChildDisposition[];
  tally: FanOutTally;
  overflowCount: number;
}

/**
 * Parse a raw `data.fan_out` value into a {@link FanOutReport}, or `null` when it is not a
 * valid report. Legacy rows stored the unread boolean `fan_out: true` — those parse to
 * `null` (no migration; historical rows render as they did before). Any malformed payload is
 * also `null`. A `null` therefore means "no report", never "empty report" — an empty fan-out
 * is a valid `{ children: [] }`.
 */
function tallyPersisted(children: readonly ChildDisposition[], overflowCount: number): FanOutTally {
  const tally = tallyChildDispositions(children);
  if (overflowCount === 0) return tally;
  tally.total += overflowCount;
  const storedAllAttention =
    children.length > 0 && children.every(child => child.kind !== 'completed');
  if (storedAllAttention) {
    tally.notCompleted += overflowCount;
  } else {
    tally.completed += overflowCount;
    tally.notCompleted = tally.total - tally.completed;
  }
  return tally;
}

export function parseFanOutReport(raw: unknown): FanOutReport | null {
  const parsed = fanOutReportPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const overflowCount = parsed.data.overflowCount ?? 0;
  return {
    children: parsed.data.children,
    tally: tallyPersisted(parsed.data.children, overflowCount),
    overflowCount,
  };
}

/** The short headline used by the run header and the notify prefix. */
export function formatFanOutHeadline(tally: FanOutTally): string {
  const children = tally.total === 1 ? 'child' : 'children';
  return `${String(tally.notCompleted)} of ${String(tally.total)} ${children} did not complete`;
}

/**
 * The category breakdown (`"2 completed, 1 failed"` / `"3 never ran"`). Cancels are generic
 * here (`"1 cancelled"` = engine + out-of-band); the indexed child lines carry the specific
 * reason. Only non-zero categories appear; returns `''` when nothing to break down.
 */
export function formatFanOutBreakdown(tally: FanOutTally): string {
  const parts: string[] = [];
  if (tally.completed > 0) parts.push(`${String(tally.completed)} completed`);
  if (tally.failed > 0) parts.push(`${String(tally.failed)} failed`);
  const cancelled = tally.cancelledByEngine + tally.cancelledOutOfBand;
  if (cancelled > 0) parts.push(`${String(cancelled)} cancelled`);
  if (tally.neverRan > 0) parts.push(`${String(tally.neverRan)} never ran`);
  return parts.join(', ');
}

/**
 * The full tally string: headline plus breakdown, e.g.
 * `"1 of 3 children did not complete (2 completed, 1 failed)"`. Says "did not complete", not
 * "failed", so a never-ran slot is not relabelled a failure. Used by the CLI block, the log
 * divider, and the notify warning.
 */
export function formatFanOutTally(tally: FanOutTally): string {
  const breakdown = formatFanOutBreakdown(tally);
  const headline = formatFanOutHeadline(tally);
  return breakdown ? `${headline} (${breakdown})` : headline;
}

// ---------------------------------------------------------------------------
// Execution outcome type (not persisted directly — reduced into the wire record)
// ---------------------------------------------------------------------------

/** A fan-out slot that produced a run row (the ordinary case). */
export interface ChildRanOutcome {
  kind: 'ran';
  childRunId: string;
  status: 'completed' | 'paused' | 'failed' | 'cancelled';
  /** `metadata.cancelled_reason` when the child was cancelled — decides engine vs out-of-band. */
  cancelledReason?: string;
  /** Child's terminal output (its first sink node's output), threaded as `$<id>.output`. */
  output?: string;
  /** Child run's total cost, rolled up into the parent node's costUsd. */
  costUsd?: number;
  tokens?: TokenUsage;
  error?: string;
}

/** A fan-out slot that never produced a run row (`childRunId` is unrepresentable). */
export interface ChildNeverRanOutcome {
  kind: 'never_ran';
  reason: ChildNeverRanReason;
  error: string;
}

/**
 * Terminal (or paused) outcome of a child sub-run, as consumed by a `workflow:` node. A
 * two-variant union so an empty-string `childRunId` cannot be represented: a slot that never
 * ran carries a reason, not a fake id.
 */
export type ChildWorkflowOutcome = ChildRanOutcome | ChildNeverRanOutcome;

/** Construct a `never_ran` outcome (every pre-row failure). */
export function neverRan(reason: ChildNeverRanReason, error: string): ChildNeverRanOutcome {
  return { kind: 'never_ran', reason, error };
}

/** Construct a `ran` + `failed` outcome (a post-row failure — the child row exists). */
export function ranFailed(childRunId: string, error: string): ChildRanOutcome {
  return { kind: 'ran', childRunId, status: 'failed', error };
}

/**
 * Reduce one child outcome to its persisted wire disposition. A `ran` + `cancelled` outcome
 * splits on `cancelledReason`: a recognized engine reason → `cancelled_by_engine`, anything
 * else (a user cancel, a path-lock loss with no tag) → `cancelled_out_of_band`. A `paused`
 * outcome should never reach here (the gate path cancels it before the join), but is mapped
 * defensively to `cancelled_by_engine` / `fan_out_gate` rather than dropped.
 */
export function toChildDisposition(outcome: ChildWorkflowOutcome, index: number): ChildDisposition {
  if (outcome.kind === 'never_ran') {
    return {
      kind: 'never_ran',
      index,
      reason: outcome.reason,
      error: fanOutExcerpt(outcome.error),
    };
  }
  switch (outcome.status) {
    case 'completed':
      return { kind: 'completed', index, childRunId: outcome.childRunId };
    case 'failed':
      return {
        kind: 'failed',
        index,
        childRunId: outcome.childRunId,
        error: fanOutExcerpt(outcome.error ?? 'child failed'),
      };
    case 'cancelled': {
      const engine = fanOutEngineCancelReasonSchema.safeParse(outcome.cancelledReason);
      if (engine.success) {
        return {
          kind: 'cancelled_by_engine',
          index,
          childRunId: outcome.childRunId,
          reason: engine.data,
        };
      }
      return {
        kind: 'cancelled_out_of_band',
        index,
        childRunId: outcome.childRunId,
        ...(outcome.error ? { error: fanOutExcerpt(outcome.error) } : {}),
      };
    }
    case 'paused':
      return {
        kind: 'cancelled_by_engine',
        index,
        childRunId: outcome.childRunId,
        reason: 'fan_out_gate',
      };
    default: {
      const exhaustiveCheck: never = outcome.status;
      throw new Error(`Unhandled child outcome status: ${String(exhaustiveCheck)}`);
    }
  }
}

/** Build the persisted `{ children }` payload from the ordered outcomes. */
export function buildFanOutReportPayload(
  outcomes: readonly ChildWorkflowOutcome[]
): FanOutReportPayload {
  const children = outcomes.map((outcome, index) => toChildDisposition(outcome, index));
  if (children.length <= FAN_OUT_CHILDREN_MAX) {
    return { children };
  }
  const attention = children.filter(child => child.kind !== 'completed');
  if (attention.length >= FAN_OUT_CHILDREN_MAX) {
    const kept = [...attention].sort((a, b) => a.index - b.index).slice(0, FAN_OUT_CHILDREN_MAX);
    return { children: kept, overflowCount: children.length - kept.length };
  }
  const room = FAN_OUT_CHILDREN_MAX - attention.length;
  const keptCompleted = children.filter(child => child.kind === 'completed').slice(0, room);
  const kept = [...attention, ...keptCompleted].sort((a, b) => a.index - b.index);
  return { children: kept, overflowCount: children.length - kept.length };
}

/** Format one indexed child line for the CLI/console divider (specific cancel reason). */
export function formatChildDispositionLine(child: ChildDisposition): string {
  const shortId = 'childRunId' in child ? `${child.childRunId.slice(0, 8)} · ` : '';
  switch (child.kind) {
    case 'completed':
      return `[${String(child.index)}] completed · ${child.childRunId.slice(0, 8)}`;
    case 'failed':
      return `[${String(child.index)}] failed · ${shortId}${child.error}`;
    case 'cancelled_by_engine':
      return `[${String(child.index)}] cancelled (${child.reason}) · ${child.childRunId.slice(0, 8)}`;
    case 'cancelled_out_of_band':
      return `[${String(child.index)}] cancelled · ${shortId}${child.error ?? 'cancelled out of band'}`;
    case 'never_ran':
      return `[${String(child.index)}] never ran · ${child.error}`;
    default: {
      const exhaustiveCheck: never = child;
      throw new Error(`Unhandled child disposition: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Read-time DTO for HTTP clients. Derived from `data.fan_out` — never persisted.
 * Structured children so `@archon/web` can render without importing this package.
 */
export const fanOutViewSchema = z.object({
  children: z.array(childDispositionSchema),
  tally: fanOutTallySchema,
  overflowCount: z.number().int().nonnegative(),
});
export type FanOutView = z.infer<typeof fanOutViewSchema>;

/**
 * Build the API view from a workflow event's `data` bag, or `null` when `data.fan_out`
 * is missing, legacy `true`, or malformed.
 */
export function toFanOutView(eventData: unknown): FanOutView | null {
  if (typeof eventData !== 'object' || eventData === null) return null;
  const report = parseFanOutReport((eventData as Record<string, unknown>).fan_out);
  if (report === null) return null;
  return {
    children: report.children,
    tally: report.tally,
    overflowCount: report.overflowCount,
  };
}
