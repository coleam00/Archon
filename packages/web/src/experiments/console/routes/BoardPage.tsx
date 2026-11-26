/**
 * The board of a project that runs a staged pack: its work orders, its open items under the
 * stage each is on, a last column of the items merged in the last week, the ones that need a
 * decision, the ones set aside, and the asks that wait. A Table view lists the same items.
 *
 * It decides nothing. Whether an item is open is the item read's `standing`, the stages and
 * their order are the pack graph's, and the stage an item stands at is `placeFor`'s: its run's
 * stage, or the one the factory view maps a retired workflow's runs to. An open item at no stage
 * of the flow is set aside with that reason; there is no column for it. How stages are grouped
 * into columns is the pack's to say, in its own document: the graph read carries the groups and
 * the board names none itself. Which items go in which group, and the numbers the Overview
 * shows, are `packBoard`'s (`factory/lib/board-numbers.ts`).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useItemAsks } from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { BoardTable } from '../factory/BoardTable';
import { AsksUnread } from '../factory/AsksUnread';
import { BoardToolbar, useBoardView, type BoardView } from '../factory/BoardToolbar';
import { ColumnHeader } from '../factory/ColumnHeader';
import { TONES } from '../factory/tones';
import { toneOfKind } from '../factory/lib/map-columns';
import { stageLabel } from '../factory/lib/stage-words';
import { groupsOf, type GroupKind } from '../factory/lib/view-groups';
import { useFactoryCards } from '../factory/cards-context';
import { FactoryCardsProvider, useForgeTitles } from '../factory/FactoryCards';
import { askReadOf } from '../factory/lib/item-asks';
import { MergedColumn } from '../factory/MergedColumn';
import { SetAsideStrip } from '../factory/SetAsideStrip';
import { useBoardItems } from '../factory/useBoardItems';
import { WorkOrdersStrip } from '../factory/WorkOrdersStrip';
import {
  ON_NO_PACK,
  ON_NO_STAGE,
  packBoard,
  placeFor,
  projectSetAside,
  type PackBoardGroups,
  type Place,
} from '../factory/lib/board-numbers';
import type { FactoryView } from '../factory/api';
import type { TableRow } from '../factory/lib/board-table';
import { itemMatches } from '../factory/lib/item-card';
import { workOrders } from '../factory/lib/work-orders';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import { getPackGraph, type ItemRead, type PackGraph } from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { CardList } from './board/ItemCard';
import { isMoving, stageAt } from './board/standing';

// console-token-exception md:min-h-[34rem] -- the board area's floor in a short window: the toolbar, the work orders and room for a card or two.
const BOARD_AREA = 'flex flex-col md:h-full md:min-h-[34rem] md:shrink-0';

/**
 * A column: a group, or one stage, with its stages by their names in the pack, and the kind the
 * pack's view file gives the group (its colour; none reads neutral, never a colour by position).
 */
export type StageGroup = PackGraph['groups'][number] & { kind?: GroupKind };

/** A column as the board and the map draw it. `name` stays its key; `heading` is display only. */
export type BoardColumn = StageGroup & {
  /** What the column is called on screen: its group's name, or its lone stage's `stageLabel`. */
  heading: string;
  /** A group heads the column; false for a lone stage no group holds, whose `name` is its id. */
  grouped: boolean;
};

/**
 * A pack's columns: each group its document declares (or each of `groups`, a factory map's own),
 * then each stage of its flow that no group holds, in the graph's order, named by `view`'s label
 * for it. A workflow only other workflows call is not a stage.
 */
export function columnsOf(
  graph: PackGraph | undefined,
  groups: readonly StageGroup[] = graph?.groups ?? [],
  view: Pick<FactoryView, 'stages'> | null = null
): BoardColumn[] {
  const stages = (graph?.stages ?? []).filter(stage => stage.inFlow).map(stage => stage.workflow);
  const grouped = new Set(groups.flatMap(group => group.stages));
  return [
    ...groups.map(group => ({
      ...group,
      stages: group.stages.filter(s => stages.includes(s)),
      heading: group.name,
      grouped: true,
    })),
    ...stages
      .filter(stage => !grouped.has(stage))
      .map(stage => ({
        name: stage,
        stages: [stage],
        heading: stageLabel(view, stage),
        grouped: false,
      })),
  ].filter(column => column.stages.length > 0);
}

/**
 * One column with its items. Every column of a row is the same width, an empty one too. Its
 * header names it and its stages in words (`stageLabel`); the raw ids are the hover titles.
 */
function Column({
  name,
  label,
  stages,
  labelOf,
  items,
  projectId,
  stageOf,
  focus = false,
  lit = null,
  accent,
}: {
  /** The column's key: its group's name, or the workflow id of a stage no group holds. */
  name: string;
  /** The column's heading: its group's name, or its lone stage's label. */
  label: string;
  /** The column's colour, as the bar on its header and on each card (Visual standard, rule 2). */
  accent?: string;
  /** The column's stages, by workflow id. */
  stages: readonly string[];
  /** A stage's label, which the header's subtitle lists. */
  labelOf: (workflow: string) => string;
  items: ItemRead[];
  projectId: string;
  lit?: ReadonlySet<string> | null;
  /** Given for a column of several stages, so each card says which one it is on. */
  stageOf?: (read: ItemRead) => string | undefined;
  /** The board was opened at this column (`?group=`): it is brought into view once. */
  focus?: boolean;
}): ReactElement {
  const empty = items.length === 0;
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) column.current?.scrollIntoView({ block: 'nearest', inline: 'start' });
  }, [focus]);
  return (
    <div
      ref={column}
      data-stage={name}
      data-empty={empty ? '' : undefined}
      className="flex flex-col md:min-h-0 md:w-0 md:min-w-44 md:flex-1"
    >
      <ColumnHeader
        label={label}
        labelHover={label === name ? undefined : name}
        subtitle={stages.map(labelOf).join(', ')}
        subtitleHover={stages.join(', ')}
        items={items}
        bar={accent}
      />
      {empty ? (
        <p className="mt-3 text-console-12 text-text-tertiary">Nothing here</p>
      ) : (
        <CardList
          reads={items}
          projectId={projectId}
          stageNameOf={
            stageOf === undefined
              ? undefined
              : read => {
                  const at = stageOf(read);
                  return at === undefined ? undefined : labelOf(at);
                }
          }
          lit={lit}
          accent={accent}
          className="mt-3 flex flex-col gap-3 md:min-h-0 md:flex-1 md:overflow-y-auto md:pb-2 md:pr-1"
        />
      )}
    </div>
  );
}

const DECIDE_SHOWN = 6;
const MORE_PAGE = 20;

/**
 * The first few items of a list, and more of them a page at a time: what the needs-a-decision
 * strip shows. The list is already read whole (the board's every-item read), so showing more
 * reads nothing.
 */
function useMore(
  reads: readonly ItemRead[] | undefined,
  error: Error | undefined
): {
  shown: ItemRead[];
  more: boolean;
  expanded: boolean;
  busy: boolean;
  error: string | undefined;
  load: () => void;
  collapse: () => void;
} {
  const [count, setCount] = useState(DECIDE_SHOWN);
  const all = reads ?? [];
  return {
    shown: all.slice(0, count),
    more: all.length > count,
    expanded: count > DECIDE_SHOWN,
    busy: false,
    error: error?.message,
    load: () => {
      setCount(count + MORE_PAGE);
    },
    collapse: () => {
      setCount(DECIDE_SHOWN);
    },
  };
}

const MORE_BUTTON =
  'mt-2 mr-2 rounded border border-border px-2 py-1 text-console-11 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50';

function MoreControls({
  list,
  total,
}: {
  list: ReturnType<typeof useMore>;
  total: number;
}): ReactElement {
  return (
    <>
      {list.error !== undefined ? (
        <p className="mt-2 text-console-11 text-error">{list.error}</p>
      ) : null}
      {list.more ? (
        <button type="button" disabled={list.busy} onClick={list.load} className={MORE_BUTTON}>
          {list.busy ? 'Reading…' : `Show more of ${String(total)}`}
        </button>
      ) : null}
      {list.expanded ? (
        <button type="button" onClick={list.collapse} className={MORE_BUTTON}>
          Show fewer
        </button>
      ) : null}
    </>
  );
}

const DECIDE: readonly string[] = ['failed', 'stopped'];

/**
 * The items nothing moves until an operator decides: the last run failed, or it ended with
 * an outcome and nothing followed. Newest first, a few shown, each with its reason. They are
 * the failed and stopped items of the board's every-item read, which the server orders newest
 * first as a failed-and-stopped read would, so the strip asks the server for nothing more.
 */
function DecisionStrip({
  projectId,
  every,
}: {
  projectId: string;
  every: { data: ItemRead[] | undefined; error: Error | undefined };
}): ReactElement | null {
  const decide = every.data?.filter(read => DECIDE.includes(read.standing.state));
  const total = decide?.length ?? 0;
  const list = useMore(decide, every.error);
  if (list.shown.length === 0 && list.error === undefined) return null;
  return (
    <section data-needs-decision className="mb-6">
      <h2 className="text-sm font-medium text-text-primary">
        Failed or stopped: needs a decision{' '}
        <span data-decide-total className="font-normal text-text-tertiary">
          {total}
        </span>
      </h2>
      <p className="mt-1 text-console-12 text-text-tertiary">
        Nothing moves these until a new run starts on them or their change merges.
      </p>
      <CardList
        reads={list.shown}
        projectId={projectId}
        className="mt-3 grid gap-2 md:grid-cols-3"
      />
      <MoreControls list={list} total={total} />
    </section>
  );
}

/** The Table's rows for one pack: its columns' cards in board order, then decisions, then Merged. */
function tableRows(
  board: PackBoardGroups,
  names: readonly string[],
  columnOf: (read: ItemRead) => number
): { rows: TableRow[]; earlier: TableRow[] } {
  const merged = (read: ItemRead): TableRow => ({
    read,
    column: 'Merged',
    columnOrder: names.length + 1,
  });
  return {
    rows: [
      ...board.moving
        .map(read => ({ read, column: names[columnOf(read)] ?? '', columnOrder: columnOf(read) }))
        .sort((a, b) => a.columnOrder - b.columnOrder),
      ...board.decide.map(read => ({
        read,
        column: 'Needs a decision',
        columnOrder: names.length,
      })),
      ...board.merged.recent.map(merged),
    ],
    earlier: board.merged.earlier.map(merged),
  };
}

/**
 * A pack's columns, each with the open items standing at it, then Merged; or the same items
 * as a Table. A column is a group the pack's document declares (the graph read carries them),
 * or a stage of the graph that no group holds, in the graph's order. `place` puts each item at
 * its stage; until the pack's view is read the graph alone places, and an item it cannot place
 * is drawn nowhere until `place` sets it aside.
 */
export function PackBoard({
  projectId,
  pack,
  board,
  place,
  counted,
  view = 'pipeline',
  earlier = false,
  lit = null,
  itemsError,
}: {
  projectId: string;
  pack: string;
  board: PackBoardGroups;
  /** The stage each item is at (`placeFor`); absent until the pack's graph and view are read. */
  place?: Place;
  /** Every item is read, so Merged and the Table are whole. */
  counted: boolean;
  view?: BoardView;
  /** The Table opens with its earlier merges listed. */
  earlier?: boolean;
  /** The ids of a highlighted work order's members. */
  lit?: ReadonlySet<string> | null;
  /** The every-item read failed. */
  itemsError?: Error;
}): ReactElement {
  const { data: graph, error } = useEntity<PackGraph>(K.packGraph(projectId, pack), () =>
    getPackGraph(projectId, pack)
  );
  const stageOf = place ?? ((read: ItemRead): string | undefined => stageAt(read, graph?.stages));
  // The same groups the map draws: the view file's, else the pack document's.
  const packView = useFactoryCards()?.packs?.get(pack)?.view ?? null;
  const groups = groupsOf(packView, graph);
  const columns = columnsOf(graph, groups, packView);
  const labelOf = (workflow: string): string => stageLabel(packView, workflow);
  const focus = useSearchParams()[0].get('group');
  const items = board.moving;
  // A pack with nothing on its board has nothing to show.
  if (counted && board.onBoard.length === 0) return <></>;
  const columnOf = (read: ItemRead): number =>
    columns.findIndex(column => column.stages.includes(stageOf(read) ?? ''));
  const table = tableRows(
    board,
    columns.map(column => column.heading),
    columnOf
  );
  return (
    <section data-pack={pack} className="mb-4 flex flex-col md:min-h-80 md:flex-1">
      <h2 className="text-sm font-medium text-text-primary">{pack}</h2>
      {error !== undefined ? (
        // With no stages there are no columns: the open items stay in sight under the reason.
        <div data-stages-unread>
          <p className="mt-1 text-console-12 text-error">
            The pack's stages could not be read, so its open items are on no column: {error.message}
          </p>
          <CardList
            reads={items}
            projectId={projectId}
            lit={lit}
            className="mt-3 grid gap-2 md:grid-cols-3"
          />
        </div>
      ) : graph === undefined ? (
        <p className="mt-2 text-console-12 text-text-tertiary">Loading stages…</p>
      ) : view === 'table' ? (
        <BoardTable
          projectId={projectId}
          rows={table.rows}
          earlier={table.earlier}
          showEarlier={earlier}
        />
      ) : (
        <div
          data-board-columns
          className="mt-3 flex flex-col gap-3 md:min-h-0 md:flex-1 md:flex-row md:overflow-x-auto md:overflow-y-hidden"
        >
          {columns.map(column => (
            <Column
              key={column.name}
              name={column.name}
              label={column.heading}
              stages={column.stages}
              labelOf={labelOf}
              items={items.filter(read => column.stages.includes(stageOf(read) ?? ''))}
              projectId={projectId}
              stageOf={column.stages.length > 1 ? stageOf : undefined}
              focus={focus === column.name}
              lit={lit}
              accent={TONES[toneOfKind(column.kind)].color}
            />
          ))}
          <MergedColumn
            projectId={projectId}
            recent={board.merged.recent}
            earlier={board.merged.earlier.length}
            counted={counted}
            error={itemsError}
            lit={lit}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Each pack's placement (`placeFor`), from the graph and view the board cards read for it
 * (`FactoryCardsProvider`). Absent for a pack while those reads are out, or when its graph
 * could not be read; a pack whose view could not be read places by its graph alone.
 */
function usePlaces(packs: readonly string[]): ReadonlyMap<string, Place> {
  const read = useFactoryCards()?.packs;
  const places = new Map<string, Place>();
  for (const pack of packs) {
    const cardPack = read?.get(pack);
    if (cardPack !== undefined) places.set(pack, placeFor(cardPack.stages, cardPack.view));
  }
  return places;
}

/** "N on a stage": the open items a pack's stage holds, once the packs are read. */
function OnStageStatus({
  open,
  packs,
}: {
  open: { data: ItemRead[] | undefined; error: Error | undefined };
  packs: readonly string[];
}): ReactElement {
  const places = usePlaces(packs);
  const now = new Date();
  const onStage = (reads: readonly ItemRead[]): number =>
    packs.reduce(
      (sum, pack) => sum + packBoard(reads, pack, now, places.get(pack)).moving.length,
      0
    );
  return (
    <p role="status" className="text-xs text-text-tertiary">
      {open.error !== undefined
        ? open.error.message
        : open.data === undefined
          ? 'Reading items…'
          : `${String(onStage(open.data))} on a stage`}
    </p>
  );
}

/** Each pack's columns, its open items placed at their stages. */
function PackBoards({
  projectId,
  packs,
  items,
  counted,
  itemsError,
  view,
  earlier,
  lit,
}: {
  projectId: string;
  packs: readonly string[];
  /** The items the filter keeps. */
  items: readonly ItemRead[];
  counted: boolean;
  itemsError: Error | undefined;
  view: BoardView;
  earlier: boolean;
  lit: ReadonlySet<string> | null;
}): ReactElement {
  const places = usePlaces(packs);
  const now = new Date();
  return (
    <>
      {packs.map(pack => (
        <PackBoard
          key={pack}
          projectId={projectId}
          pack={pack}
          board={packBoard(items, pack, now, places.get(pack))}
          place={places.get(pack)}
          counted={counted}
          view={view}
          earlier={earlier}
          lit={lit}
          itemsError={itemsError}
        />
      ))}
    </>
  );
}

/**
 * The project's items set aside: those that ended without merging or rest, and the open ones
 * at no stage: a pack's that no stage of its flow holds, and those standing at no pack's run.
 */
function BoardSetAside({
  projectId,
  packs,
  every,
  matches,
}: {
  projectId: string;
  packs: readonly string[];
  /** Every item of the project; undefined while it is read. */
  every: ItemRead[] | undefined;
  matches: (read: ItemRead) => boolean;
}): ReactElement | null {
  const places = usePlaces(packs);
  const now = new Date();
  const items = every ?? [];
  const unplaced = [
    ...packs.flatMap(pack =>
      packBoard(items, pack, now, places.get(pack)).unplaced.map(read => ({
        read,
        why: ON_NO_STAGE,
      }))
    ),
    ...items
      .filter(read => isMoving(read) && read.standing.pack === null)
      .map(read => ({ read, why: ON_NO_PACK })),
  ];
  return (
    <SetAsideStrip
      projectId={projectId}
      entries={projectSetAside(items, unplaced).filter(entry => matches(entry.read))}
    />
  );
}

export function BoardPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const project = projects?.find(candidate => candidate.id === projectId);
  const {
    data: attention,
    error: attentionError,
    refetch: refetchAttention,
  } = useEntity<skill.RunsAttention>(K.runsAttention, skill.listRunsNeedingAttention);
  const asks = useItemAsks(attention, projectId);
  const itemAsks = askReadOf(attention, attentionError, asks);
  const [filter, setFilter] = useState('');
  const [order, setOrder] = useState<string | null>(null);
  const { view, earlier, setView } = useBoardView();
  // Every item, which every group, count and strip reads: one read, so the board asks the
  // server to place its items once (DESIGN.md, "Speed is a requirement").
  const every = useBoardItems(projectId);
  const all = every.data ?? [];
  const orders = workOrders(all);
  const lit = orders.find(entry => entry.item.id === order);
  const litIds = lit === undefined ? null : new Set(lit.members.map(member => member.item.id));
  // The filter searches what each card shows: its issue title and its key as a person reads it.
  // The titles are read only once something is typed, so a cold board's first reads are the
  // stage columns' own.
  const wanted = filter.trim().toLowerCase();
  const titles = useForgeTitles(wanted === '' ? null : projectId, all);
  const matches = (read: ItemRead): boolean => itemMatches(read, titles, wanted);
  const items = all.filter(matches);
  // Every pack with an item in the project, so a pack with nothing open still shows Merged.
  const packs = [
    ...new Set([
      ...(project?.itemPacks ?? []),
      ...items.filter(isMoving).flatMap(read => read.standing.pack ?? []),
    ]),
  ].sort();

  return (
    <FactoryCardsProvider
      projectId={projectId}
      // Until the project is read its packs are unknown, and an empty list would read as all read.
      packs={project === undefined ? null : packs}
      itemAsks={itemAsks}
    >
      <section className="flex h-full min-h-0 flex-col">
        <header className="flex flex-col gap-3 border-b border-border px-4 py-4 md:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-medium text-text-primary">
              {project?.name ?? 'Project'}
            </h1>
            <OnStageStatus
              open={{ data: every.data?.filter(isMoving), error: every.error }}
              packs={packs}
            />
          </div>
          <ProjectViewTabs projectId={projectId} active="board" />
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4 pt-4 md:px-6">
          {/* The board area fills the window's height, so each column scrolls on its own; what
              follows it runs on below, in the page's scroll. */}
          <div className={BOARD_AREA}>
            {/* No card and no header counts needs-you while the asks are unread; said once here,
                above every pack's columns and either view, rather than per card (#258). */}
            {itemAsks === 'failed' && attentionError !== undefined ? (
              <div className="mb-3">
                <AsksUnread error={attentionError} retry={refetchAttention} />
              </div>
            ) : null}
            <BoardToolbar filter={filter} onFilter={setFilter} view={view} onView={setView} />
            <WorkOrdersStrip
              orders={orders}
              counted={every.data !== undefined}
              error={every.error}
              lit={lit === undefined ? null : lit.item.id}
              onLight={setOrder}
            />
            <PackBoards
              projectId={projectId}
              packs={packs}
              items={items}
              counted={every.data !== undefined}
              itemsError={every.error}
              view={view}
              earlier={earlier}
              lit={litIds}
            />
          </div>
          <DecisionStrip projectId={projectId} every={every} />
          <BoardSetAside projectId={projectId} packs={packs} every={every.data} matches={matches} />
        </div>
      </section>
    </FactoryCardsProvider>
  );
}
