/**
 * The board, as pure derivation: what each item's card says and how the cards group into
 * columns, from the items read and the factory view declaration (DESIGN.md, "The board").
 * Which column an item sits in is `placement.ts`'s, the one placement the map and the item
 * page share. Nothing
 * here names a pack's stages, workflows, steps or outcomes; every one comes from the
 * declaration or the engine's records.
 */
import { formatDateTime } from '../../lib/format';
import { displayItemKey } from './item-key';
import type { FactoryItem } from '../../skills/factory';
import { askQuestion } from '../../lib/ask-card';
import { awaitingItems, needsYou } from '../../lib/needs-you';
import { BOARD_SHOW, showsCard, waitsOnYou, type BoardShow } from './board-show';
import { boardColumns, type BoardColumnDecl } from './board-columns';
import { anyMergePending, stageCountPending, type ChangeMerged } from './merge-pending';
import {
  isStopped,
  pageItemColumn,
  pagePlacementInput,
  stageIdOf,
  stoppedStage,
  UNPLACED_LABEL,
  type ItemColumn,
} from './placement';
import { boardShadowLine, type ShadowWords } from './shadows';
import { bySinceNewest, setAsideOf, type SetAside, type SetAsideReason } from './set-aside';
import { roundsSources, runLine, stoppedLine, type RunLine } from './step-label';
import type { FactoryStage } from './stage-steps';
import { factoryPath, type FactoryViewListed } from './views';
import { membershipOf } from './work-orders';

export type FactoryDeclaration = FactoryViewListed['declaration'];
type Progress = NonNullable<FactoryItem['progress']>;
export type RoundVerdict = NonNullable<Progress['round']>['rounds'][number]['verdict'];

export type Pill = 'running' | 'needs-you' | 'failed' | 'awaits' | 'parked' | 'waiting' | 'landed';

/**
 * Each state's words. An `awaits` card reads its declared label instead ("Needs shaping"), as
 * `itemPill` gives it; this one stands for the state where no item names it (a sort, a legend).
 */
export const PILL_LABEL: Record<Pill, string> = {
  running: 'Running',
  'needs-you': 'Needs you',
  failed: 'Failed',
  awaits: 'Waits on you',
  parked: 'Parked',
  waiting: 'Waiting',
  landed: 'Merged',
};

/** Plain words for each verdict a round can have; a new verdict fails the type-check here. */
const VERDICT_LABEL: Record<RoundVerdict, string> = {
  approved: 'approved',
  returned: 'returned',
  undecided: 'needs a decision',
  running: 'running',
  stopped: 'stopped',
};

/** A card's fields, in the order DESIGN.md lists them. */
export interface BoardCard {
  key: string;
  title: string;
  pill: Pill;
  /** The pill's words: `PILL_LABEL`, or an `awaits` item's declared label. */
  pillLabel: string;
  round: {
    text: string;
    dots: { iteration: number; verdict: RoundVerdict; label: string }[];
  } | null;
  /**
   * What the running run is doing, as `runLine` words it; `step` is the raw engine id, for
   * the hover title only.
   */
  run: (RunLine & { step: string | null; href: string }) | null;
  /**
   * The label of the stage the item sits in, so a card names it inside a column that groups
   * several; null for a merged card, whose column says it, and for an item in no stage.
   */
  stage: string | null;
  returned: { count: number; href: string } | null;
  /**
   * The change, by its pull request number when known. `mergeState` when the change host
   * could not say whether it merged (`unknown`) or the server is still asking (`pending`):
   * the card says so rather than reading as unmerged. `href` is null while the change host
   * has not named the pull request of a run that named no URL.
   */
  change: {
    href: string | null;
    label: string;
    mergeState: Extract<ChangeMerged, string> | null;
  } | null;
  /** When the change merged, in local time; only in the landed stage. */
  mergedAt: string | null;
  /**
   * What stopped a failed item, what an item that needs you asks, or, for one waiting on you
   * with no ask, what it waits on: its first open question, else its reason.
   */
  stopLine: string | null;
  /** How many questions an item waiting on you recorded, when several ("4 questions"). */
  stopCount: string | null;
  /** The key of the work order the item is part of (`membershipOf`); null when none. */
  order: string | null;
  /**
   * What a shadow step of the item's stage would have done, as `boardShadowLine` picks it
   * ("would ask you first"); null when none decided, and on a card a run works now.
   */
  shadow: ShadowWords | null;
}

/** The item page's path. */
export function itemPath(projectId: string, key: string): string {
  return factoryPath(projectId, `/items/${encodeURIComponent(key)}`);
}

/**
 * Whether a run of a stage-form rounds workflow works the item now: a round its result has
 * not numbered yet. It is never one of `progress.round`'s, which only completed runs give.
 */
export function newRoundRunning(view: FactoryDeclaration, progress: Progress | null): boolean {
  const running = progress?.running;
  if (running == null) return false;
  return roundsSources(view).some(
    source => !('loop' in source) && source.workflow === running.workflow
  );
}

function roundField(view: FactoryDeclaration, progress: Progress | null): BoardCard['round'] {
  const round = progress?.round ?? null;
  const next = newRoundRunning(view, progress);
  if (round === null && !next) return null;
  const dots: NonNullable<BoardCard['round']>['dots'] = (round?.rounds ?? []).map(entry => ({
    iteration: entry.iteration,
    verdict: entry.verdict,
    label: `round ${entry.iteration.toString()}: ${VERDICT_LABEL[entry.verdict]}`,
  }));
  if (round === null)
    return {
      text: 'first round running',
      dots: [{ iteration: 1, verdict: 'running', label: 'first round: running' }],
    };
  const iteration = round.iteration.toString();
  const text =
    round.max === null ? `round ${iteration}` : `round ${iteration} of ${round.max.toString()}`;
  if (!next) return { text, dots };
  // Its words name no number: after a replan the running round is the first of a new count,
  // not N+1. The dot's iteration is only its key.
  return {
    text: `${text}, next one running`,
    dots: [
      ...dots,
      { iteration: round.iteration + 1, verdict: 'running', label: 'next round: running' },
    ],
  };
}

function runField(
  view: FactoryDeclaration,
  projectId: string,
  progress: Progress | null,
  stage: FactoryStage | null
): BoardCard['run'] {
  const running = progress?.running;
  if (running == null) return null;
  return {
    ...runLine(view, running, progress?.round, stage ?? undefined),
    step: running.step,
    href: `/console/p/${projectId}/r/${running.runId}`,
  };
}

function changeField(progress: Progress | null): BoardCard['change'] {
  const change = progress?.change;
  if (change == null) return null;
  return {
    href: change.url,
    label: change.number === null ? 'the change' : `PR #${change.number.toString()}`,
    mergeState: typeof change.merged === 'string' ? change.merged : null,
  };
}

/** An item's card, given where it was placed (`itemColumn`). */
export function cardFields(
  view: FactoryDeclaration,
  projectId: string,
  item: FactoryItem,
  column: ItemColumn | null
): BoardCard {
  const { key } = item.item;
  const progress = item.progress;
  const stage = column !== null && 'stage' in column ? column.stage : null;
  const landed = stage?.id === view.landed.stage;
  const { pill, pillLabel, stopLine, stopCount } = itemPill(view, item, landed, stage?.label);
  const mergedAt = progress?.change?.mergedAt ?? null;
  const order = membershipOf(item)?.order ?? null;
  return {
    key,
    title: progress?.title ?? displayItemKey(key, order),
    pill,
    pillLabel,
    stopCount,
    round: roundField(view, progress),
    run: runField(view, projectId, progress, stage),
    stage: !landed && stage !== null ? stage.label : null,
    returned:
      progress !== null && progress.returned > 0
        ? { count: progress.returned, href: itemPath(projectId, key) }
        : null,
    change: changeField(progress),
    mergedAt: landed && mergedAt !== null ? formatDateTime(mergedAt) : null,
    stopLine,
    order,
    shadow: boardShadowLine(item, stage, view),
  };
}

/**
 * What an item waiting on you says on its card's line, as the ask face says an ask: its first
 * open question, with "N questions" when it recorded several, else the reason its run gave
 * (null when it gave neither).
 */
function awaitsLine(
  awaits: NonNullable<Progress['awaits']>
): Pick<BoardCard, 'stopLine' | 'stopCount'> {
  const [first] = awaits.questions;
  const count = awaits.questions.length;
  if (first === undefined) return { stopLine: awaits.why, stopCount: null };
  return { stopLine: first, stopCount: count > 1 ? `${count.toString()} questions` : null };
}

/**
 * The state pill, first that holds: landed (in the landed column), needs you (an open
 * ask), running, failed (the last run failed or was cancelled), awaits (the last run left it
 * waiting on a person, `progress.awaits`, in its declared words), parked (the last run kept it
 * open for later, `progress.parked`), else waiting; and the one line saying what an item that
 * needs you asks, what one waiting on you waits on, or what stopped a failed one. The board's
 * card and the item page's header both read it, so an item says the same in both.
 */
export function itemPill(
  view: FactoryDeclaration,
  item: FactoryItem,
  landed: boolean,
  /** The label of the stage the item is placed in, named when a stopped run's stage is not known. */
  placed: string | null = null
): Pick<BoardCard, 'pill' | 'pillLabel' | 'stopLine' | 'stopCount'> {
  const of = (pill: Pill, stopLine: string | null) => ({
    pill,
    pillLabel: PILL_LABEL[pill],
    stopLine,
    stopCount: null,
  });
  const unread = item.progress === null ? 'Its progress could not be read.' : null;
  if (landed) return of('landed', unread);
  const [ask] = needsYou(item.questions);
  if (ask !== undefined) return of('needs-you', unread ?? askQuestion(ask));
  if (item.progress?.running != null) return of('running', null);
  // The item's last run of a declared workflow, its discoveries drain included.
  const last = pagePlacementInput(item)
    .runs.filter(run => run.workflow !== null)
    .at(-1);
  if (last?.workflow != null && isStopped(last.status)) {
    const label = stoppedStage(view, last.workflow, last.failedStep)?.label ?? placed ?? 'The run';
    return of('failed', stoppedLine(view, last, label));
  }
  const awaits = item.progress?.awaits;
  // `awaitingItems` takes the same items, so Needs you counts what this pill shows.
  if (awaits != null && awaitingItems([item]).length === 1)
    return { pill: 'awaits', pillLabel: awaits.label, ...awaitsLine(awaits) };
  if (item.progress?.parked != null) return of('parked', null);
  return of('waiting', unread);
}

/** A card on the board: the item, where it sits, and what it says. */
export interface PlacedCard {
  item: FactoryItem;
  /** Null when no declared stage holds it, which a view changed under cached items can cause. */
  column: ItemColumn | null;
  card: BoardCard;
}

/**
 * A board column: a group of stages (`board-columns.ts`) and the cards placed on them.
 * `pending` when its count waits on a merge answer (`stageCountPending`) for any of its
 * stages: its header shows loading rather than a count that may be wrong.
 */
export interface BoardColumn extends BoardColumnDecl {
  cards: PlacedCard[];
  pending: boolean;
}

export interface BoardModel {
  /** The declaration's landed stage: the stage an item whose change merged sits in. */
  landedStage: string;
  /** The id of the column holding the landed stage: the Merged column. */
  landedColumn: string;
  columns: BoardColumn[];
  /**
   * Items with nothing left to happen (`setAsideOf`), newest last run first: an ending took
   * them off the board, they are parked, or they sat idle. In no column and no count.
   */
  setAside: SetAside[];
  /** Items placement found no column for, in the toolbar's `UNPLACED_LABEL` row. */
  unplaced: PlacedCard[];
  /**
   * Where every item sits, filter or not: a stage id (not its column's: placement holds a run
   * between named steps in the stage it read last), or `ended:<label>`.
   */
  positions: Map<string, string>;
}

/** Where an item sits, as one comparable string: a stage id, or `ended:<label>`. */
export function positionOf(column: ItemColumn | null): string {
  if (column === null) return `ended:${UNPLACED_LABEL}`;
  return 'ended' in column ? `ended:${column.ended}` : column.stage.id;
}

/**
 * Whether `query` finds the card by key, title or the key of its work order, ignoring case.
 * An empty query finds all.
 */
function cardMatches(card: BoardCard, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [card.key, card.title, card.order ?? ''].some(field =>
    field.toLowerCase().includes(needle)
  );
}

/**
 * Where an item sits and whether the board sets it aside as of `now`: the one decision the
 * board and the map (`map-live.ts`) both make, so a stage's count and its column never disagree.
 */
export function placeItem(
  view: FactoryDeclaration,
  projectId: string,
  item: FactoryItem,
  previous: string | undefined,
  now: Date
): { placed: PlacedCard; aside: SetAsideReason | null } {
  const column = pageItemColumn(view, item, previous);
  const placed = { item, column, card: cardFields(view, projectId, item, column) };
  return { placed, aside: setAsideOf(view, placed, now) };
}

/**
 * The board for these items. Columns are the declared columns in order (one per stage when
 * the view declares none), the landed stage's among them; a card goes to the column holding
 * its stage, unless the board sets it aside as of `now` (`setAsideOf`). `previous` holds each
 * item's position on the last read.
 */
export function boardModel(
  view: FactoryDeclaration,
  projectId: string,
  items: readonly FactoryItem[],
  previous: ReadonlyMap<string, string>,
  now: Date
): BoardModel {
  const columns: BoardColumn[] = boardColumns(view).map(column => ({
    ...column,
    cards: [],
    pending: false,
  }));
  const byStage = new Map(
    columns.flatMap(column => column.stages.map(stage => [stage, column] as const))
  );
  const setAside: SetAside[] = [];
  const unplaced: PlacedCard[] = [];
  const positions = new Map<string, string>();
  for (const item of items) {
    const { placed, aside } = placeItem(view, projectId, item, previous.get(item.item.key), now);
    positions.set(item.item.key, positionOf(placed.column));
    const stage = stageIdOf(placed.column);
    const holder = stage === undefined ? undefined : byStage.get(stage);
    if (aside !== null) setAside.push({ ...aside, placed });
    // The schema puts every stage in one column; a stage in none still shows, never drops.
    else if (holder !== undefined) holder.cards.push(placed);
    else unplaced.push(placed);
  }
  const anyPending = anyMergePending(items);
  for (const column of columns)
    column.pending = column.stages.some(stage =>
      stageCountPending(
        stage,
        view.landed.stage,
        column.cards.flatMap(placed => (stageIdOf(placed.column) === stage ? [placed.item] : [])),
        anyPending
      )
    );
  return {
    landedStage: view.landed.stage,
    landedColumn: byStage.get(view.landed.stage)?.id ?? view.landed.stage,
    columns,
    setAside: setAside.sort(bySinceNewest),
    unplaced,
    positions,
  };
}

/**
 * The board narrowed to the cards `query` finds by key, title or work order and, when given, to
 * the cards `show` picks (what one of the Overview's numbers counts). The set-aside items and
 * the Position unknown row narrow by the query too; while `show` narrows the board they are hidden: no number counts
 * them. A show that narrows nothing (Found opens a panel) leaves the board to the query.
 * `positions` keeps every item, so narrowing never reads as a card moving.
 */
export function filterBoard(
  model: BoardModel,
  query: string,
  show: BoardShow | undefined,
  now: Date
): BoardModel {
  const narrowing = show !== undefined && BOARD_SHOW[show].narrows ? show : undefined;
  if (query.trim() === '' && narrowing === undefined) return model;
  const landed = model.landedStage;
  const keep = (cards: PlacedCard[]): PlacedCard[] =>
    cards.filter(
      placed =>
        cardMatches(placed.card, query) &&
        (narrowing === undefined || showsCard(narrowing, placed, landed, now))
    );
  const folded = narrowing === undefined;
  return {
    ...model,
    columns: model.columns.map(column => ({ ...column, cards: keep(column.cards) })),
    setAside: folded ? model.setAside.filter(entry => cardMatches(entry.placed.card, query)) : [],
    unplaced: folded ? keep(model.unplaced) : [],
  };
}

type ChipPill = Exclude<Pill, 'landed' | 'awaits'>;
const CHIP_PILLS: readonly ChipPill[] = ['running', 'needs-you', 'failed', 'parked', 'waiting'];

/**
 * A column header's state chips: how many of its cards run, need you, failed, are parked or wait, in
 * that order, each only while above 0. A card waiting on you with no ask (`awaits`) counts in
 * the needs-you chip, as Needs you counts it. Merged cards get none: the count says it.
 */
export function columnChips(cards: readonly PlacedCard[]): { pill: ChipPill; count: number }[] {
  const chipOf = (pill: Pill): Pill => (waitsOnYou(pill) ? 'needs-you' : pill);
  return CHIP_PILLS.map(pill => ({
    pill,
    count: cards.filter(placed => chipOf(placed.card.pill) === pill).length,
  })).filter(chip => chip.count > 0);
}

/** The items whose position changed between two reads; an item new on the board did not move. */
export function movedKeys(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): string[] {
  return [...after]
    .filter(([key, position]) => before.has(key) && before.get(key) !== position)
    .map(([key]) => key);
}

/** The hint for columns scrolled out of view, naming them; null when every column shows. */
export function hiddenColumnsHint(
  columns: readonly { id: string; label: string }[],
  visible: ReadonlySet<string>
): string | null {
  const hidden = columns.filter(column => !visible.has(column.id)).map(column => column.label);
  return hidden.length === 0 ? null : `Scroll for: ${hidden.join(', ')}`;
}
