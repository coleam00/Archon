/**
 * The map's live chips: which items sit on each card, how many a run works now, and which
 * need a person. An item is placed and set aside by `board.ts`'s `placeItem`, the board's own
 * decision, so the map counts what the board counts: a card and a board column never name
 * different stages, and an item the board sets aside is in no stage. "needs you" is the item
 * page's `itemAsks`, which reads the Needs-you list's `needsYou`, so the chip agrees with both.
 */
import type { FactoryItem } from '../../skills/factory';
import type { AttentionQueueItem } from '../../skills/runs';
import { anyMergePending, stageCountPending } from './merge-pending';
import { awaitingItems, itemAsks } from '../../lib/needs-you';
import { placeItem } from './board';
import { stageIdOf } from './placement';
import type { FactoryViewListed } from './views';

interface StageLive {
  /** The items placed on this stage, in the order the items read returned them. */
  items: FactoryItem[];
  /** How many of them a run works now. */
  working: number;
  /** Those with an open ask or wait a person answers. */
  needYou: FactoryItem[];
  /**
   * Whether the count here waits on a merge answer (`stageCountPending`), as the board's
   * column does: the card says it is checking rather than a count that may be wrong.
   */
  pending: boolean;
}

/**
 * A stage before the items are read: `loading` while the first read is outstanding (a slow
 * one included, which is retried), `failed` once it failed and nothing retries it.
 */
export type Unread = 'loading' | 'failed';

/** What a card or details panel shows: the stage's chips, or why there are none yet. */
export type StageRead = StageLive | Unread;

/** A stage nothing sits on. */
export const EMPTY_STAGE_LIVE: StageLive = { items: [], working: 0, needYou: [], pending: false };

/** One stage's chips, why there are none yet, or empty when nothing sits there. */
export const stageReadOf = (live: MapLive | Unread, stage: string): StageRead =>
  typeof live === 'string' ? live : (live.stages.get(stage) ?? EMPTY_STAGE_LIVE);

/** Why an item is on no card: so the reader knows whether to fix the read or the view. */
type NotOnMapWhy =
  /** Placement found no column: the view names no stage for it (as the item page's "Position unknown"). */
  | { kind: 'no-column' }
  /** Placed on `stage`, which the map draws no card for. */
  | { kind: 'no-card'; stage: string };

export interface NotOnMap {
  item: FactoryItem;
  why: NotOnMapWhy;
}

export interface MapLive {
  /** Every declared stage, with or without a card, empty when nothing sits there. */
  stages: Map<string, StageLive>;
  /** Items no card shows: not placed, or on a stage without a card. */
  notOnMap: NotOnMap[];
  /** The stage each placed item sits in, by key: pass it back as `previous` on the next read. */
  positions: Map<string, string>;
}

/**
 * The map for these items as of `now`. `previous` holds the stage each item sat in on the last
 * read, as the board keeps it, so a run on a step no stage names holds its card where the board
 * holds its column. An item the board sets aside as of `now` (`setAsideOf`) is counted and
 * listed in no stage and is not "not on the map" either; its stage is still kept in
 * `positions`, as the board keeps it, so one that comes back does not read as moved.
 */
export function stageLive(
  view: FactoryViewListed['declaration'],
  projectId: string,
  items: readonly FactoryItem[],
  attention: readonly AttentionQueueItem[],
  previous: ReadonlyMap<string, string>,
  now: Date
): MapLive {
  const carded = new Set(view.map.cards.map(card => card.stage));
  const stages = new Map<string, StageLive>(
    view.stages.map(stage => [stage.id, { ...EMPTY_STAGE_LIVE, items: [], needYou: [] }])
  );
  const notOnMap: NotOnMap[] = [];
  const positions = new Map<string, string>();
  for (const item of items) {
    const { placed, aside } = placeItem(view, projectId, item, previous.get(item.item.key), now);
    const stage = stageIdOf(placed.column);
    const live = stage === undefined ? undefined : stages.get(stage);
    // An item an ending took off the board (`endings`) is set aside, on no card, by design.
    if (aside?.kind === 'ended') continue;
    // Reachable when the cached view changed under cached items: say so, as the item page does.
    if (stage === undefined || live === undefined) {
      notOnMap.push({ item, why: { kind: 'no-column' } });
      continue;
    }
    positions.set(item.item.key, stage);
    if (aside !== null) continue;
    countHere(live, item, attention);
    if (!carded.has(stage)) notOnMap.push({ item, why: { kind: 'no-card', stage } });
  }
  markPending(view.landed.stage, items, stages);
  return { stages, notOnMap, positions };
}

/** Counts `item` on the stage it sits in: here, worked by a run now, needing a person. */
function countHere(
  live: StageLive,
  item: FactoryItem,
  attention: readonly AttentionQueueItem[]
): void {
  live.items.push(item);
  // `progress.running` is the latest running run of a declared workflow.
  if (item.progress?.running != null) live.working += 1;
  if (needsYouHere(item, attention)) live.needYou.push(item);
}

/**
 * Whether the item needs a person: an open ask on it, or, with none, a run that left it waiting
 * on one (`awaitingItems`), as Needs you counts it.
 */
function needsYouHere(item: FactoryItem, attention: readonly AttentionQueueItem[]): boolean {
  return itemAsks(item, attention).length > 0 || awaitingItems([item]).length > 0;
}

/** Marks each stage whose count waits on a merge answer, as the board marks its columns. */
function markPending(
  landedStage: string,
  items: readonly FactoryItem[],
  stages: ReadonlyMap<string, StageLive>
): void {
  const anyPending = anyMergePending(items);
  for (const [stage, live] of stages)
    live.pending = stageCountPending(stage, landedStage, live.items, anyPending);
}
