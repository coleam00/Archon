/**
 * The board of a project that runs a staged pack: its work orders, its open items under the
 * stage each is on, a last column of the items merged in the last week, the ones that need a
 * decision, the ones set aside, and the asks that wait. A Table view lists the same items.
 *
 * It decides nothing. Where an item is and whether it is open is the item read's
 * `standing`, the stages and their order are the pack graph's, and an ask is drawn and
 * answered by the component the runs page uses. How stages are grouped into columns is the
 * pack's to say, in its own document: the graph read carries the groups and the board names
 * none itself. Which items go in which group, and the numbers the Overview shows, are
 * `packBoard`'s (`factory/lib/board-numbers.ts`).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ItemAsksSection, useItemAsks } from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { BoardTable } from '../factory/BoardTable';
import { BoardToolbar, useBoardView, type BoardView } from '../factory/BoardToolbar';
import { ColumnHeader } from '../factory/ColumnHeader';
import { FactoryCardsProvider, useForgeTitles } from '../factory/FactoryCards';
import { MergedColumn } from '../factory/MergedColumn';
import { SetAsideStrip } from '../factory/SetAsideStrip';
import { useBoardItems } from '../factory/useBoardItems';
import { WorkOrdersStrip } from '../factory/WorkOrdersStrip';
import { packBoard, projectSetAside, type PackBoardGroups } from '../factory/lib/board-numbers';
import type { TableRow } from '../factory/lib/board-table';
import { itemMatches } from '../factory/lib/item-card';
import { workOrders } from '../factory/lib/work-orders';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import {
  getPackGraph,
  listItems,
  listItemsPage,
  type ItemPage,
  type ItemRead,
  type PackGraph,
} from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { CardList } from './board/ItemCard';
import { isMoving, MOVING, stageAt } from './board/standing';

export { chipOf, MOVING } from './board/standing';

/** A column: a group the pack declares, or one stage, with its stages by their names in the pack. */
export type StageGroup = PackGraph['groups'][number];

/**
 * A pack's columns: each group its document declares, then each stage of its flow that no
 * group holds, in the graph's order. A workflow only other workflows call is not a stage.
 */
export function columnsOf(graph: PackGraph | undefined): StageGroup[] {
  const stages = (graph?.stages ?? []).filter(stage => stage.inFlow).map(stage => stage.workflow);
  const groups: readonly StageGroup[] = graph?.groups ?? [];
  const grouped = new Set(groups.flatMap(group => group.stages));
  return [
    ...groups.map(group => ({ ...group, stages: group.stages.filter(s => stages.includes(s)) })),
    ...stages.filter(stage => !grouped.has(stage)).map(stage => ({ name: stage, stages: [stage] })),
  ].filter(column => column.stages.length > 0);
}

/**
 * One column with its items. An empty column collapses to a narrow heading, so the pack's
 * order still shows and the occupied ones stay on screen.
 */
function Column({
  name,
  stages,
  items,
  projectId,
  stageOf,
  focus = false,
  lit = null,
}: {
  name: string;
  /** The column's stages, by their names in the pack: its header's subtitle. */
  stages: readonly string[];
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
      className={empty ? 'md:w-28 md:shrink-0' : 'md:w-64 md:shrink-0'}
    >
      <ColumnHeader label={name} subtitle={stages.join(', ')} items={items} />
      {empty ? null : (
        <CardList
          reads={items}
          projectId={projectId}
          stageOf={stageOf}
          lit={lit}
          className="mt-3 flex flex-col gap-3"
        />
      )}
    </div>
  );
}

const DECIDE_SHOWN = 6;
const MORE_PAGE = 20;

interface Newest {
  data: ItemPage | undefined;
  error: Error | undefined;
}

/**
 * The newest few items of a list and more of them a page at a time: what the needs-a-decision
 * strip shows. `newest` is the cached first page; `read` fetches the page
 * after a cursor.
 */
function useMore(
  newest: Newest,
  read: (after: string) => Promise<ItemPage>
): {
  shown: ItemRead[];
  more: boolean;
  expanded: boolean;
  busy: boolean;
  error: string | undefined;
  load: () => void;
  collapse: () => void;
} {
  const [extra, setExtra] = useState<ItemPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const next = extra === null ? newest.data?.next : extra.next;
  const load = async (): Promise<void> => {
    if (next == null) return;
    setBusy(true);
    setError(undefined);
    try {
      const page = await read(next);
      setExtra({ ...page, items: [...(extra?.items ?? []), ...page.items] });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'The items could not be read.');
    } finally {
      setBusy(false);
    }
  };
  return {
    shown: [...(newest.data?.items ?? []), ...(extra?.items ?? [])],
    more: next != null,
    expanded: extra !== null,
    busy,
    error: newest.error?.message ?? error,
    load: () => void load(),
    collapse: () => {
      setExtra(null);
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

const DECIDE = ['failed', 'stopped'] as const;

/**
 * The items nothing moves until an operator decides: the last run failed, or it ended with
 * an outcome and nothing followed. Newest first, a few shown, each with its reason.
 */
function DecisionStrip({ projectId }: { projectId: string }): ReactElement | null {
  const newest = useEntity<ItemPage>(K.boardDecide(projectId), () =>
    listItemsPage(projectId, DECIDE, { limit: DECIDE_SHOWN })
  );
  const totals = newest.data?.totals;
  const total = totals == null ? 0 : totals.failed + totals.stopped;
  const list = useMore(newest, after =>
    listItemsPage(projectId, DECIDE, { limit: MORE_PAGE, after })
  );
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
  columns: readonly StageGroup[],
  columnOf: (read: ItemRead) => number
): { rows: TableRow[]; earlier: TableRow[] } {
  const names = [...columns.map(column => column.name), 'Not on a stage'];
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
 * or a stage of the graph that no group holds, in the graph's order.
 */
export function PackBoard({
  projectId,
  pack,
  board,
  counted,
  view = 'pipeline',
  earlier = false,
  lit = null,
  itemsError,
}: {
  projectId: string;
  pack: string;
  board: PackBoardGroups;
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
  const stageOf = (read: ItemRead): string | undefined => stageAt(read, graph?.stages);
  const columns = columnsOf(graph);
  const stages = columns.flatMap(column => column.stages);
  const focus = useSearchParams()[0].get('group');
  const items = board.moving;
  // An item whose stage the pack no longer has, or whose pack could not be read, stays visible.
  const offStage = items.filter(read => !stages.includes(stageOf(read) ?? ''));
  // A pack with nothing on its board has nothing to show.
  if (counted && board.onBoard.length === 0) return <></>;
  const columnOf = (read: ItemRead): number => {
    const at = columns.findIndex(column => column.stages.includes(stageOf(read) ?? ''));
    return at === -1 ? columns.length : at;
  };
  const table = tableRows(board, columns, columnOf);
  return (
    <section data-pack={pack} className="mb-6">
      <h2 className="flex flex-wrap items-baseline gap-x-3 text-sm font-medium text-text-primary">
        {pack}
        <span data-pack-links className="text-console-11 font-normal text-text-tertiary">
          <Link
            className="underline hover:text-text-primary"
            to={`/console/p/${encodeURIComponent(projectId)}/packs/${encodeURIComponent(pack)}/setup`}
          >
            Setup
          </Link>
          {' · '}
          <Link
            className="underline hover:text-text-primary"
            to={`/console/p/${encodeURIComponent(projectId)}/packs/${encodeURIComponent(pack)}/settings`}
          >
            Settings
          </Link>
        </span>
      </h2>
      {error !== undefined ? (
        <p className="mt-1 text-console-12 text-error">{error.message}</p>
      ) : null}
      {graph === undefined && error === undefined ? (
        <p className="mt-2 text-console-12 text-text-tertiary">Loading stages…</p>
      ) : view === 'table' ? (
        <BoardTable
          projectId={projectId}
          rows={table.rows}
          earlier={table.earlier}
          showEarlier={earlier}
        />
      ) : (
        <div className="mt-3 flex flex-col gap-3 md:flex-row md:overflow-x-auto md:pb-2">
          {columns.map(column => (
            <Column
              key={column.name}
              name={column.name}
              stages={column.stages}
              items={items.filter(read => column.stages.includes(stageOf(read) ?? ''))}
              projectId={projectId}
              stageOf={column.stages.length > 1 ? stageOf : undefined}
              focus={focus === column.name}
              lit={lit}
            />
          ))}
          {offStage.length > 0 ? (
            <Column
              name="Not on a stage"
              stages={[]}
              items={offStage}
              projectId={projectId}
              lit={lit}
            />
          ) : null}
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

/** The items open on no pack's stage, behind a toggle. */
function OutsidePacks({
  projectId,
  outside,
}: {
  projectId: string;
  outside: ItemRead[];
}): ReactElement | null {
  const [shown, setShown] = useState(false);
  if (outside.length === 0) return null;
  return (
    <section data-outside-pack className="mb-6">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => {
          setShown(was => !was);
        }}
        className="rounded border border-border px-3 py-1.5 text-console-12 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
      >
        {shown ? 'Hide' : 'Show'} {outside.length} open on no pack stage
      </button>
      {shown ? (
        <CardList
          reads={outside}
          projectId={projectId}
          className="mt-3 grid gap-2 md:grid-cols-3"
        />
      ) : null}
    </section>
  );
}

export function BoardPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const project = projects?.find(candidate => candidate.id === projectId);
  const open = useEntity<ItemRead[]>(K.board(projectId), () => listItems(projectId, MOVING));
  const { data: attention } = useEntity<skill.RunsAttention>(
    K.runsAttention,
    skill.listRunsNeedingAttention
  );
  const itemAsks = useItemAsks(attention, projectId);
  const [filter, setFilter] = useState('');
  const [order, setOrder] = useState<string | null>(null);
  const { view, earlier, setView } = useBoardView();
  // Every item, which every group and count reads; the open ones stand in until it answers.
  const every = useBoardItems(projectId);
  const all = every.data ?? open.data ?? [];
  // Only from every item: the open ones alone would give a wrong total (the strip waits).
  const orders = workOrders(every.data ?? []);
  const lit = orders.find(entry => entry.item.id === order);
  const litIds = lit === undefined ? null : new Set(lit.members.map(member => member.item.id));
  // The filter searches what each card shows: its issue title and its key as a person reads it.
  // The titles are read only once something is typed, so a cold board's first reads are the
  // stage columns' own.
  const wanted = filter.trim().toLowerCase();
  const titles = useForgeTitles(wanted === '' ? null : projectId, all);
  const items = all.filter(read => itemMatches(read, titles, wanted));
  const now = new Date();
  const packOf = (read: ItemRead): string | undefined => read.standing.pack ?? undefined;
  const moving = items.filter(isMoving);
  // Every pack with an item in the project, so a pack with nothing open still shows Merged.
  const packs = [
    ...new Set([...(project?.itemPacks ?? []), ...moving.flatMap(read => packOf(read) ?? [])]),
  ].sort();

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-4 md:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-base font-medium text-text-primary">
            {project?.name ?? 'Project'}
          </h1>
          <p role="status" className="text-xs text-text-tertiary">
            {open.error !== undefined
              ? open.error.message
              : open.data === undefined
                ? 'Reading items…'
                : `${String(open.data.length)} on a stage`}
          </p>
        </div>
        <ProjectViewTabs projectId={projectId} active="board" />
      </header>
      <FactoryCardsProvider
        projectId={projectId}
        // Until the project is read its packs are unknown, and an empty list would read as all read.
        packs={project === undefined ? null : packs}
        itemAsks={itemAsks}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4 md:px-6">
          <BoardToolbar filter={filter} onFilter={setFilter} view={view} onView={setView} />
          <WorkOrdersStrip
            orders={orders}
            counted={every.data !== undefined}
            error={every.error}
            lit={lit === undefined ? null : lit.item.id}
            onLight={setOrder}
          />
          {packs.map(pack => (
            <PackBoard
              key={pack}
              projectId={projectId}
              pack={pack}
              board={packBoard(items, pack, now)}
              counted={every.data !== undefined}
              view={view}
              earlier={earlier}
              lit={litIds}
              itemsError={every.error}
            />
          ))}
          <DecisionStrip projectId={projectId} />
          <SetAsideStrip
            projectId={projectId}
            entries={projectSetAside(every.data ?? []).filter(entry =>
              itemMatches(entry.read, titles, wanted)
            )}
          />
          <OutsidePacks
            projectId={projectId}
            outside={moving.filter(read => packOf(read) === undefined)}
          />
          {itemAsks.asks.length + itemAsks.answered.length > 0 ? (
            <section data-needs-you className="mt-8">
              <h2 className="text-sm font-medium text-text-primary">Needs you</h2>
              <div className="mt-3 flex flex-col gap-3">
                <ItemAsksSection {...itemAsks} showProject={false} />
              </div>
            </section>
          ) : null}
        </div>
      </FactoryCardsProvider>
    </section>
  );
}
