/**
 * The board's groups and numbers, as one rendering of the server's placement: each item's
 * `standing`, its `merged` record and its links. Nothing here places an item again. The
 * Board's columns, its Merged column and Table, and the Overview's tiles and flow all read
 * `packBoard`, so the two pages count the same items the same way.
 */
import { ensureUtc } from '../../lib/format';
import type { ItemRead } from '../../skills/items';
import { howItEnded, isMoving, needsDecision, standingRun } from '../../routes/board/standing';

/** How many local calendar days the Merged column lists, today included. */
export const MERGED_DAYS = 7;

const ms = (iso: string): number => new Date(ensureUtc(iso)).getTime();

/** The median of `values`; the mean of the two middle ones for an even count. */
export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return null;
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/**
 * From the item's earliest run starting to its change merging. Null when it has not merged,
 * has no run, or the merge is recorded before its first run (a merge recorded by hand).
 */
export function timeToMerged(read: ItemRead): number | null {
  if (read.merged === null || read.runs.length === 0) return null;
  const span = ms(read.merged.at) - Math.min(...read.runs.map(run => ms(run.startedAt)));
  return Number.isFinite(span) && span >= 0 ? span : null;
}

/** A work order: an item others are `part_of` now. Its work is in its parts. */
export const isOrder = (read: ItemRead): boolean =>
  read.links.some(
    link => link.kind === 'part_of' && link.direction === 'incoming' && link.ended === null
  );

export interface SetAside {
  read: ItemRead;
  /** Why it is off the board, in the engine's facts. */
  why: string;
  /** When its last run ended; null when that is not recorded. */
  since: string | null;
}

/**
 * Whether the item is set aside: nothing moves it and nothing waits on a decision, and it did
 * not merge. It ended with a final outcome (standing `done` with no merge), or it is at rest
 * (its last run was cancelled or declared no outcome). A work order is never set aside: its
 * parts carry its work.
 */
export function setAsideOf(read: ItemRead): SetAside | null {
  if (isOrder(read)) return null;
  const { state } = read.standing;
  const run = standingRun(read);
  const since = run?.completedAt ?? null;
  if (state === 'done' && read.merged === null) return { read, why: howItEnded(read), since };
  if (state !== 'resting') return null;
  return { read, why: run?.status === 'cancelled' ? 'Cancelled' : 'Ended with no outcome', since };
}

/** Every item set aside in the project, the most recently ended first. */
export function projectSetAside(items: readonly ItemRead[]): SetAside[] {
  const at = (entry: SetAside): number => (entry.since === null ? 0 : ms(entry.since));
  return items.flatMap(read => setAsideOf(read) ?? []).sort((a, b) => at(b) - at(a));
}

export interface BoardNumbers {
  /** Items on a stage: running, waiting or queued. */
  inFlight: number;
  mergedToday: number;
  /** Merged within the last `MERGED_DAYS` local days: the Merged column's count. */
  mergedRecent: number;
  /** N of "N of M merged". */
  merged: number;
  /** M of "N of M merged": every item on the board; the items set aside are not. */
  total: number;
  /** Median of `timeToMerged` over the merged items; null when none has one. */
  medianToMergedMs: number | null;
}

export interface PackBoardGroups {
  /** On a stage: the columns. A work order with a run of its own on a stage is here too. */
  moving: ItemRead[];
  /** Failed or stopped: the decision strip. */
  decide: ItemRead[];
  /**
   * Merged, newest first: `recent` in the Merged column, `earlier` only in the Table. A work
   * order whose own change merged is here like any item; one done through its parts has no
   * merge of its own and shows only in the work-orders strip.
   */
  merged: { recent: ItemRead[]; earlier: ItemRead[] };
  /** Everything the board shows for the pack: moving, then decide, then merged. */
  onBoard: ItemRead[];
  numbers: BoardNumbers;
}

const startOfLocalDay = (now: Date, daysBack: number): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).getTime();

/** The groups and numbers of one pack's items, from `items` (every item of the project). */
export function packBoard(items: readonly ItemRead[], pack: string, now: Date): PackBoardGroups {
  const own = items.filter(read => read.standing.pack === pack);
  const moving = own.filter(isMoving);
  const decide = own.filter(needsDecision);
  const merged = own
    .filter(read => read.standing.state === 'done' && read.merged !== null)
    .map(read => ({ read, at: ms(read.merged?.at ?? '') }))
    .sort((a, b) => b.at - a.at);
  const since = startOfLocalDay(now, MERGED_DAYS - 1);
  const today = startOfLocalDay(now, 0);
  const recent = merged.filter(entry => entry.at >= since).map(entry => entry.read);
  const earlier = merged.filter(entry => !(entry.at >= since)).map(entry => entry.read);
  const all = merged.map(entry => entry.read);
  return {
    moving,
    decide,
    merged: { recent, earlier },
    onBoard: [...moving, ...decide, ...all],
    numbers: {
      inFlight: moving.length,
      mergedToday: merged.filter(entry => entry.at >= today).length,
      mergedRecent: recent.length,
      merged: all.length,
      total: moving.length + decide.length + all.length,
      medianToMergedMs: median(all.flatMap(read => timeToMerged(read) ?? [])),
    },
  };
}
