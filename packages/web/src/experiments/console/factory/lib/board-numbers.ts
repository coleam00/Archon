/**
 * The board's groups and numbers, as one rendering of the server's placement: each item's
 * `standing`, its `merged` record and its links. Which stage a moving item is at is
 * `stageAt`'s, through `placeFor`; nothing else places an item. The Board's columns, its
 * Merged column, Set aside strip and Table, and the Overview's tiles and flow all read
 * `packBoard`, so the two pages count the same items the same way.
 */
import { ensureUtc } from '../../lib/format';
import type { ItemRead } from '../../skills/items';
import {
  howItEnded,
  isMoving,
  needsDecision,
  stageAt,
  standingRun,
  type OutcomeWords,
} from '../../routes/board/standing';
import type { FactoryWords } from './graph-view';
import type { PackGraphStage } from './item-card';

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
  /** Why it is off the board, in the engine's facts and the pack's words. */
  why: string;
  /** When its last run ended; null when that is not recorded. */
  since: string | null;
}

/**
 * Whether the item is set aside: nothing moves it and nothing waits on a decision, and it did
 * not merge. An outcome finished it (standing `done` with no merge: the engine's end, or an
 * older run's final outcome), or it is at rest (its last run was cancelled or declared no
 * outcome, or an operator ended it). A work order is never set aside: its
 * parts carry its work.
 */
export function setAsideOf(read: ItemRead, outcomeOf: OutcomeWords): SetAside | null {
  if (isOrder(read)) return null;
  const { state } = read.standing;
  const run = standingRun(read);
  const since = run?.completedAt ?? null;
  if (state === 'done' && read.merged === null)
    return { read, why: howItEnded(read, outcomeOf), since };
  if (state !== 'resting') return null;
  return { read, why: run?.status === 'cancelled' ? 'Cancelled' : 'Ended with no outcome', since };
}

/** Why a moving item no stage column holds is set aside. */
export const ON_NO_STAGE = 'On no stage';
/** Why a moving item that stands at no pack's run is set aside. */
export const ON_NO_PACK = "On no pack's stage";

/**
 * Every item set aside in the project, the most recently ended first: the ones `setAsideOf`
 * names, and the moving items no stage places (`unplaced`, from each `packBoard`), since their
 * run started. `wordsFor` words each item's outcome (`outcomeWordsFor`).
 */
export function projectSetAside(
  items: readonly ItemRead[],
  wordsFor: (read: ItemRead) => OutcomeWords,
  unplaced: readonly { read: ItemRead; why: string }[] = []
): SetAside[] {
  const at = (entry: SetAside): number => (entry.since === null ? 0 : ms(entry.since));
  return [
    ...items.flatMap(read => setAsideOf(read, wordsFor(read)) ?? []),
    ...unplaced.map(({ read, why }) => ({
      read,
      why,
      since: standingRun(read)?.startedAt ?? null,
    })),
  ].sort((a, b) => at(b) - at(a));
}

/** Where `placeFor` puts a moving item: an in-flow stage's workflow, or none. */
export type Place = (read: ItemRead) => string | undefined;

/**
 * The one placement rule the Board and the Overview share: the in-flow stage `stageAt` puts an
 * item at, given the pack graph's stages and the retired workflows its stages replace
 * (`graph-view.ts`: a retired workflow's runs place at the stage that replaces it). Undefined
 * for an item at no stage of the flow.
 */
export function placeFor(
  stages: readonly PackGraphStage[],
  words: Pick<FactoryWords, 'retired'>
): Place {
  const { retired } = words;
  const inFlow = new Set(stages.filter(stage => stage.inFlow).map(stage => stage.workflow));
  return read => {
    const at = stageAt(read, stages, retired);
    return at !== undefined && inFlow.has(at) ? at : undefined;
  };
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
  /** Running, waiting or queued, but at no stage of the flow: set aside, not counted. */
  unplaced: ItemRead[];
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

/**
 * The groups and numbers of one pack's items, from `items` (every item of the project). With
 * `place` (`placeFor`), a moving item it places at no stage is `unplaced`; without it (the
 * pack's graph or view not read yet) every moving item counts as moving.
 */
export function packBoard(
  items: readonly ItemRead[],
  pack: string,
  now: Date,
  place?: Place
): PackBoardGroups {
  const own = items.filter(read => read.standing.pack === pack);
  const placed = (read: ItemRead): boolean => place === undefined || place(read) !== undefined;
  const moving = own.filter(read => isMoving(read) && placed(read));
  const unplaced = own.filter(read => isMoving(read) && !placed(read));
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
    unplaced,
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
