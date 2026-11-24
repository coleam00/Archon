/**
 * Which items the board sets aside: items with nothing left to happen, folded out of the
 * columns into one "N set aside" line (DESIGN.md, "The board", Set aside). It is how the
 * console reads the items, computed from the current read each time, so a new run, answer or
 * order brings an item back at once; nothing is stored or written. Nothing here names a pack:
 * an ending's label comes from the view's `endings`, a parked one's from its `parked`, the
 * rest from the engine's records.
 */
import { ensureUtc } from '../../lib/format';
import type { FactoryDeclaration, PlacedCard } from './board';
import { mergeUnknown } from './merge-pending';

/** How long an item rests after its last run before the idle rule sets it aside. */
export const SET_ASIDE_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

/** What an idle set-aside item says where its stage would be (a work order's member list). */
export const SET_ASIDE_LABEL = 'Set aside';

/** Why an item is set aside: an ending took it off the board, it is parked, or it sat idle. */
type SetAsideKind = 'ended' | 'parked' | 'idle';

export interface SetAsideReason {
  kind: SetAsideKind;
  /** Why, in the strip's words: the ending's or parked label, or what the idle item lacks. */
  why: string;
  /** The reason its run gave, for the hover title; null when none. */
  detail: string | null;
  /** When its last run ended (the engine's timestamp); null when no run has. */
  since: string | null;
}

/** A card the board set aside, and why. */
export interface SetAside extends SetAsideReason {
  placed: PlacedCard;
}

const NO_CHANGE = 'no change was proposed';
const MERGE_UNREAD = 'its merge state could not be read';

const sentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * When the item's last run ended: the latest `completedAt` of its runs. Null when it has no
 * run, or when one has not ended (running, pending or paused), so it has no "last run" yet.
 */
function lastRunEnd(item: PlacedCard['item']): string | null {
  if (item.runs.length === 0) return null;
  let latest: { at: string; ms: number } | null = null;
  for (const run of item.runs) {
    if (run.completedAt === null) return null;
    const ms = Date.parse(ensureUtc(run.completedAt));
    if (latest === null || ms > latest.ms) latest = { at: run.completedAt, ms };
  }
  return latest?.at ?? null;
}

/**
 * Whether something is still to happen to an item in a stage: it sits in the landed stage,
 * its progress could not be read (so the console cannot tell), a run of it has not ended
 * (running, pending or paused: placement counts only a running one), it needs you, it waits
 * on a person with no ask open (`awaits`: Needs you counts it, so the board shows it), or a
 * start waits for it (queued, or held behind a project hold).
 */
function live(view: FactoryDeclaration, { item, card, column }: PlacedCard): boolean {
  if (column === null || 'ended' in column || column.stage.id === view.landed.stage) return true;
  if (item.progress === null || item.progress.running != null) return true;
  if (item.runs.some(run => run.completedAt === null)) return true;
  if (card.pill === 'needs-you' || card.pill === 'awaits' || card.pill === 'running') return true;
  return item.queued.length > 0 || item.held.length > 0;
}

/**
 * The idle rule: its last run ended strictly more than `SET_ASIDE_IDLE_MS` before `now`, and it
 * never proposed a change or its change's merge state is a settled unknown. A failed or
 * cancelled last run qualifies too; its stop line leads the why.
 */
function idle(placed: PlacedCard, since: string | null, now: Date): SetAsideReason | null {
  if (since === null) return null;
  if (now.getTime() - Date.parse(ensureUtc(since)) <= SET_ASIDE_IDLE_MS) return null;
  const { item, card } = placed;
  const lacks =
    item.progress?.change == null ? NO_CHANGE : mergeUnknown(item) ? MERGE_UNREAD : null;
  if (lacks === null) return null;
  const why =
    card.pill === 'failed' && card.stopLine !== null
      ? `${card.stopLine}; ${lacks}`
      : sentence(lacks);
  return { kind: 'idle', why, detail: null, since };
}

/**
 * Whether the board sets `placed` aside, first that holds; null when it stays in its column.
 * An item an ending took off the board (`{ ended }`) is set aside whatever else holds: it has
 * no column to go back to (an open ask on it still shows in Needs you). One placement found no
 * column for is not: it keeps its own "Position unknown" row. Otherwise a live item
 * (`live`) never is; a parked one is; an idle one is by the idle rule.
 */
export function setAsideOf(
  view: FactoryDeclaration,
  placed: PlacedCard,
  now: Date
): SetAsideReason | null {
  const { column, item, card } = placed;
  if (column === null) return null;
  const since = lastRunEnd(item);
  if ('ended' in column) return { kind: 'ended', why: column.ended, detail: null, since };
  if (live(view, placed)) return null;
  const parked = item.progress?.parked;
  if (card.pill === 'parked' && parked != null)
    return { kind: 'parked', why: parked.label, detail: parked.why, since };
  return idle(placed, since, now);
}

/** Newest first by when the last run ended; an item with no ended run last. */
export function bySinceNewest(a: SetAsideReason, b: SetAsideReason): number {
  if (a.since === null || b.since === null)
    return (a.since === null ? 1 : 0) - (b.since === null ? 1 : 0);
  return Date.parse(ensureUtc(b.since)) - Date.parse(ensureUtc(a.since));
}
