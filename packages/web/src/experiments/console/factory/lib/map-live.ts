/**
 * The map's live chips: which items sit on each map stage, how many a run works now, and which
 * need a person. An item sits where the engine's `standing` puts it, the placement the board
 * draws (`stageAt` and `chipOf` in `routes/board/standing.ts`): on the map stage listing the
 * stage it stands at. So a stage's count is the board's count for the same stages, and no
 * second placement exists. The board's Merged column (`packBoard`'s recent merged items) sits on
 * the map's landed stage (`curated-view.ts`), so every stage's count is the items it lists.
 */
import { chipOf, stageAt } from '../../routes/board/standing';
import type { ItemRead, PackGraph } from '../../skills/items';
import type { CuratedView } from './curated-view';

interface StageLive {
  /** The items placed on this stage, in the order the items read returned them. */
  items: ItemRead[];
  /** How many of them a run works now. */
  working: number;
  /** Those with an open ask a person answers. */
  needYou: ItemRead[];
}

/**
 * A stage before the items are read: `loading` while the first read is outstanding,
 * `failed` once it failed.
 */
export type Unread = 'loading' | 'failed';

/** What a card or details panel shows: the stage's chips, or why there are none yet. */
export type StageRead = StageLive | Unread;

/** A stage nothing sits on. */
export const EMPTY_STAGE_LIVE: StageLive = { items: [], working: 0, needYou: [] };

/** One stage's chips, why there are none yet, or empty when nothing sits there. */
export const stageReadOf = (live: MapLive | Unread, stage: string): StageRead =>
  typeof live === 'string' ? live : (live.stages.get(stage) ?? EMPTY_STAGE_LIVE);

/** An item on no map stage: the workflow it stands at, which no card lists, or none. */
export interface NotOnMap {
  item: ItemRead;
  workflow: string | null;
}

export interface MapLive {
  /** Every map stage, empty when nothing sits there. */
  stages: Map<string, StageLive>;
  /** Items no card shows, so the cards never undercount silently. */
  notOnMap: NotOnMap[];
}

/**
 * The map for the pack's moving items and its Merged column. `moving` are the items the board draws on
 * its stage columns; `merged` the ones its Merged column lists.
 */
export function stageLive(
  view: Pick<CuratedView, 'stages' | 'landed'>,
  moving: readonly ItemRead[],
  merged: readonly ItemRead[],
  /** The graph's stages, which place a run that recorded no workflow name (`stageAt`). */
  graphStages: PackGraph['stages'] | undefined
): MapLive {
  const stages = new Map<string, StageLive>(
    view.stages.map(stage => [stage.id, { ...EMPTY_STAGE_LIVE, items: [], needYou: [] }])
  );
  const notOnMap: NotOnMap[] = [];
  for (const read of moving) {
    const workflow = stageAt(read, graphStages) ?? null;
    const stage =
      workflow === null ? undefined : view.stages.find(s => s.workflows.includes(workflow));
    const live = stage === undefined ? undefined : stages.get(stage.id);
    if (live === undefined) {
      notOnMap.push({ item: read, workflow });
      continue;
    }
    live.items.push(read);
    if (read.standing.state === 'running') live.working += 1;
    if (chipOf(read) === 'needs_you') live.needYou.push(read);
  }
  const landed = stages.get(view.landed.stage);
  landed?.items.push(...merged);
  return { stages, notOnMap };
}
