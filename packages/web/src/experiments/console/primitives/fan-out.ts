/**
 * Fan-out child outcome observability — CONSOLE MIRROR (#2451).
 *
 * `@archon/web` must never import `@archon/workflows`, so the parse / tally / format that the
 * engine exposes in `packages/workflows/src/schemas/fan-out-report.ts` is mirrored here by
 * hand (the same relationship `SUBRUN_METADATA_KEYS` has). Keep the two in sync:
 *
 *   engine  → packages/workflows/src/schemas/fan-out-report.ts
 *   console → packages/web/src/experiments/console/primitives/fan-out.ts  (this file)
 *
 * The wire record persisted on `node_completed` / `node_failed` is `data.fan_out =
 * { children: ChildDisposition[] }`. The tally is DERIVED at parse (never stored). Legacy rows
 * stored the unread boolean `fan_out: true` — those parse to `null` here, so a historical run
 * renders exactly as it did before. `parseFanOutReport` returns `null` for anything that is not
 * a valid report; `null` means "no report", never "empty report".
 */

/** Why a fan-out slot never produced a run row. */
export type ChildNeverRanReason = 'unresolved_target' | 'blocked_before_spawn' | 'slot_threw';

/** Engine-owned `cancelled_reason` values (attributable cancels). */
export type FanOutEngineCancelReason = 'fan_out_gate' | 'fan_out_orphan' | 'fan_out_sibling';

/** One fan-out slot's persisted disposition (mirror of the engine's `ChildDisposition`). */
export type ChildDisposition =
  | { kind: 'completed'; index: number; childRunId: string }
  | { kind: 'failed'; index: number; childRunId: string; error: string }
  | {
      kind: 'cancelled_by_engine';
      index: number;
      childRunId: string;
      reason: FanOutEngineCancelReason;
    }
  | { kind: 'cancelled_out_of_band'; index: number; childRunId: string; error?: string }
  | { kind: 'never_ran'; index: number; reason: ChildNeverRanReason; error: string };

/** Derived counts over a fan-out's dispositions (mirror of the engine's `FanOutTally`). */
export interface FanOutTally {
  total: number;
  completed: number;
  failed: number;
  cancelledByEngine: number;
  cancelledOutOfBand: number;
  neverRan: number;
  notCompleted: number;
}

/** A parsed fan-out report: the persisted children plus the derived tally. */
export interface FanOutReport {
  children: ChildDisposition[];
  tally: FanOutTally;
}

const NEVER_RAN_REASONS: ReadonlySet<string> = new Set<ChildNeverRanReason>([
  'unresolved_target',
  'blocked_before_spawn',
  'slot_threw',
]);
const ENGINE_CANCEL_REASONS: ReadonlySet<string> = new Set<FanOutEngineCancelReason>([
  'fan_out_gate',
  'fan_out_orphan',
  'fan_out_sibling',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Validate one raw child entry into a typed `ChildDisposition`, or `null` if malformed. */
function parseChildDisposition(raw: unknown): ChildDisposition | null {
  if (!isRecord(raw)) return null;
  if (!isNonNegInt(raw.index)) return null;
  const index = raw.index;
  switch (raw.kind) {
    case 'completed':
      return isNonEmptyString(raw.childRunId)
        ? { kind: 'completed', index, childRunId: raw.childRunId }
        : null;
    case 'failed':
      return isNonEmptyString(raw.childRunId) && typeof raw.error === 'string'
        ? { kind: 'failed', index, childRunId: raw.childRunId, error: raw.error }
        : null;
    case 'cancelled_by_engine':
      return isNonEmptyString(raw.childRunId) &&
        typeof raw.reason === 'string' &&
        ENGINE_CANCEL_REASONS.has(raw.reason)
        ? {
            kind: 'cancelled_by_engine',
            index,
            childRunId: raw.childRunId,
            reason: raw.reason as FanOutEngineCancelReason,
          }
        : null;
    case 'cancelled_out_of_band':
      if (!isNonEmptyString(raw.childRunId)) return null;
      return typeof raw.error === 'string'
        ? { kind: 'cancelled_out_of_band', index, childRunId: raw.childRunId, error: raw.error }
        : { kind: 'cancelled_out_of_band', index, childRunId: raw.childRunId };
    case 'never_ran':
      return typeof raw.reason === 'string' &&
        NEVER_RAN_REASONS.has(raw.reason) &&
        typeof raw.error === 'string'
        ? { kind: 'never_ran', index, reason: raw.reason as ChildNeverRanReason, error: raw.error }
        : null;
    default:
      return null;
  }
}

/**
 * Derive the tally from the ordered dispositions. Exhaustive `switch` on `kind` — the
 * `default` arm is loud (counts nothing but does not throw in the browser) rather than
 * silently dropping an unknown slot.
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
      default:
        break;
    }
  }
  tally.notCompleted = tally.total - tally.completed;
  return tally;
}

/**
 * Parse a raw `data.fan_out` value into a {@link FanOutReport}, or `null` when it is not a
 * valid report (including the legacy boolean `fan_out: true`). Every child must validate; a
 * single malformed slot rejects the whole report (rebuilding from `node_output` is explicitly
 * NOT done — the plan calls for `null`, not a reconstruction).
 */
export function parseFanOutReport(raw: unknown): FanOutReport | null {
  if (!isRecord(raw) || !Array.isArray(raw.children)) return null;
  const children: ChildDisposition[] = [];
  for (const entry of raw.children) {
    const parsed = parseChildDisposition(entry);
    if (parsed === null) return null;
    children.push(parsed);
  }
  return { children, tally: tallyChildDispositions(children) };
}

/** The short headline used by the run header. */
export function formatFanOutHeadline(tally: FanOutTally): string {
  const children = tally.total === 1 ? 'child' : 'children';
  return `${String(tally.notCompleted)} of ${String(tally.total)} ${children} did not complete`;
}

/** The category breakdown (`"2 completed, 1 failed"` / `"3 never ran"`); cancels generic. */
export function formatFanOutBreakdown(tally: FanOutTally): string {
  const parts: string[] = [];
  if (tally.completed > 0) parts.push(`${String(tally.completed)} completed`);
  if (tally.failed > 0) parts.push(`${String(tally.failed)} failed`);
  const cancelled = tally.cancelledByEngine + tally.cancelledOutOfBand;
  if (cancelled > 0) parts.push(`${String(cancelled)} cancelled`);
  if (tally.neverRan > 0) parts.push(`${String(tally.neverRan)} never ran`);
  return parts.join(', ');
}

/** The full tally string: headline plus breakdown. Says "did not complete", not "failed". */
export function formatFanOutTally(tally: FanOutTally): string {
  const breakdown = formatFanOutBreakdown(tally);
  const headline = formatFanOutHeadline(tally);
  return breakdown ? `${headline} (${breakdown})` : headline;
}

/** One indexed child line for the log divider (specific cancel reason). */
export function formatChildDispositionLine(child: ChildDisposition): string {
  switch (child.kind) {
    case 'completed':
      return `[${String(child.index)}] completed · ${child.childRunId.slice(0, 8)}`;
    case 'failed':
      return `[${String(child.index)}] failed · ${child.childRunId.slice(0, 8)} · ${child.error}`;
    case 'cancelled_by_engine':
      return `[${String(child.index)}] cancelled (${child.reason}) · ${child.childRunId.slice(0, 8)}`;
    case 'cancelled_out_of_band':
      return `[${String(child.index)}] cancelled · ${child.childRunId.slice(0, 8)} · ${child.error ?? 'cancelled out of band'}`;
    case 'never_ran':
      return `[${String(child.index)}] never ran · ${child.error}`;
    default:
      return '[?] unknown disposition';
  }
}

/**
 * Summarize every fan-out node on a run from its terminal events' reports. Used by the run
 * header to compute the "N of M children did not complete" qualifier across the whole run.
 * Sums each fan-out node's `notCompleted`/`total`.
 */
export function summarizeRunFanOut(
  reports: readonly (FanOutReport | null)[]
): { notCompleted: number; total: number } | null {
  let notCompleted = 0;
  let total = 0;
  let seen = false;
  for (const report of reports) {
    if (report === null) continue;
    seen = true;
    notCompleted += report.tally.notCompleted;
    total += report.tally.total;
  }
  return seen ? { notCompleted, total } : null;
}
