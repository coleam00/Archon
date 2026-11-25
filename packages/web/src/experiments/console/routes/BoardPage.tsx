/**
 * The board of a project that runs a staged pack: its open items under the stage each is
 * on, a last column of the items whose story ended, the ones that need a decision, and the
 * asks that wait.
 *
 * It decides nothing. Where an item is and whether it is open is the item read's
 * `standing`, the stages and their order are the pack graph's, and an ask is drawn and
 * answered by the component the runs page uses. How stages are grouped into columns is the
 * pack's to say, in its own document: the graph read carries the groups and the board names
 * none itself.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ItemAsksSection, useItemAsks } from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { FactoryCardsProvider, useForgeTitles } from '../factory/FactoryCards';
import { itemMatches } from '../factory/lib/item-card';
import { displayItemKey } from '../lib/item-key';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import {
  getItem,
  getPackGraph,
  ITEM_STATES,
  listItems,
  listItemsPage,
  type ItemPage,
  type ItemRead,
  type PackGraph,
} from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { CardList } from './board/ItemCard';
import { CHIP, chipOf, standingRun, type Chip } from './board/standing';

export { chipOf, standingRun } from './board/standing';

/** The states of an item that is on a stage: something runs, is queued or waits on it. */
export const MOVING = ['running', 'waiting', 'queued'] as const;

/** The work order an item is part of: the item its active `part_of` link points at. */
function orderOf(read: ItemRead): ItemRead['item'] | undefined {
  return read.links.find(
    link => link.kind === 'part_of' && link.direction === 'outgoing' && link.ended === null
  )?.other;
}

/** What the items of a stage are doing, as counts: `1 needs you · 2 running`. */
function stageLine(items: ItemRead[]): string {
  return (Object.keys(CHIP) as Chip[])
    .flatMap(chip => {
      const count = items.filter(read => chipOf(read) === chip).length;
      return count === 0 ? [] : [`${String(count)} ${CHIP[chip].label.toLowerCase()}`];
    })
    .join(' · ');
}

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

/** The newest done items of a pack with the total: the board's Done column and the overview's. */
export function newestDone(projectId: string, pack: string): Promise<ItemPage> {
  return listItemsPage(projectId, ['done'], { pack, limit: DONE_SHOWN });
}

/**
 * One column with its items. An empty column collapses to a narrow heading, so the pack's
 * order still shows and the occupied ones stay on screen.
 */
function Column({
  name,
  items,
  projectId,
  stageOf,
  focus = false,
}: {
  name: string;
  items: ItemRead[];
  projectId: string;
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
      className={empty ? 'md:w-24 md:shrink-0' : 'md:w-64 md:shrink-0'}
    >
      <h3
        title={name}
        className={`flex items-baseline justify-between gap-2 border-b border-border pb-1 text-console-12 font-semibold ${empty ? 'text-text-tertiary' : 'text-text-secondary'}`}
      >
        <span className="truncate">{name}</span>
        <span className="text-text-tertiary">{items.length}</span>
      </h3>
      {empty ? null : (
        <p data-stage-line className="mt-1 text-console-11 text-text-tertiary">
          {stageLine(items)}
        </p>
      )}
      {empty ? null : (
        <CardList
          reads={items}
          projectId={projectId}
          stageOf={stageOf}
          className="mt-2 flex flex-col gap-2"
        />
      )}
    </div>
  );
}

const DONE_SHOWN = 5;
const DECIDE_SHOWN = 6;
const MORE_PAGE = 20;

interface Newest {
  data: ItemPage | undefined;
  error: Error | undefined;
}

/**
 * The newest few items of a list and more of them a page at a time: what Done and the
 * needs-a-decision strip show. `newest` is the cached first page; `read` fetches the page
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

/**
 * The board's own last column: the pack's items that are done, newest first. It shows a few
 * with the total in its heading, and reads more a page at a time when opened.
 */
function DoneColumn({
  projectId,
  pack,
  newest,
}: {
  projectId: string;
  pack: string;
  newest: Newest;
}): ReactElement {
  const total = newest.data?.totals?.done ?? 0;
  const list = useMore(newest, after =>
    listItemsPage(projectId, ['done'], { pack, limit: MORE_PAGE, after })
  );
  return (
    <div data-done className="md:w-64 md:shrink-0">
      <h3 className="flex items-baseline justify-between gap-2 border-b border-border pb-1 text-console-12 font-semibold text-text-secondary">
        <span>Done</span>
        <span data-done-total className="text-text-tertiary">
          {total}
        </span>
      </h3>
      <CardList reads={list.shown} projectId={projectId} className="mt-2 flex flex-col gap-2" />
      <MoreControls list={list} total={total} />
    </div>
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

/**
 * A pack's columns, each with the open items standing at it, then Done. A column is a group
 * the pack's document declares (the graph read carries them), or a stage of the graph that
 * no group holds, in the graph's order.
 */
export function PackBoard({
  projectId,
  pack,
  items,
}: {
  projectId: string;
  pack: string;
  items: ItemRead[];
}): ReactElement {
  const { data: graph, error } = useEntity<PackGraph>(K.packGraph(projectId, pack), () =>
    getPackGraph(projectId, pack)
  );
  const newest = useEntity<ItemPage>(K.boardDone(projectId, pack), () =>
    newestDone(projectId, pack)
  );
  // A run from an older build recorded no workflow name in its pack: its published name is
  // the graph stage's own name, so the stage is found from that.
  const stageOf = (read: ItemRead): string | undefined => {
    const run = standingRun(read);
    if (run === undefined) return undefined;
    return run.pack?.workflow ?? graph?.stages.find(stage => stage.name === run.workflow)?.workflow;
  };
  const columns = columnsOf(graph);
  const stages = columns.flatMap(column => column.stages);
  const focus = useSearchParams()[0].get('group');
  // An item whose stage the pack no longer has, or whose pack could not be read, stays visible.
  const offStage = items.filter(read => !stages.includes(stageOf(read) ?? ''));
  // A pack with nothing open and nothing done has nothing to show.
  if (items.length === 0 && newest.data?.totals?.done === 0) return <></>;
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
      ) : (
        <div className="mt-3 flex flex-col gap-4 md:flex-row md:overflow-x-auto md:pb-2">
          {columns.map(column => (
            <Column
              key={column.name}
              name={column.name}
              items={items.filter(read => column.stages.includes(stageOf(read) ?? ''))}
              projectId={projectId}
              stageOf={column.stages.length > 1 ? stageOf : undefined}
              focus={focus === column.name}
            />
          ))}
          {offStage.length > 0 ? (
            <Column name="Not on a stage" items={offStage} projectId={projectId} />
          ) : null}
          <DoneColumn projectId={projectId} pack={pack} newest={newest} />
        </div>
      )}
    </section>
  );
}

/** A member of a work order, with its read when it has a run (the window lists only those). */
interface Member {
  item: ItemRead['item'];
  read: ItemRead | undefined;
}

interface WorkOrder {
  item: ItemRead['item'];
  members: Member[];
}

/** Whether a link joins a member to its work order, now. */
const activePartOf = (link: ItemRead['links'][number]): boolean =>
  link.kind === 'part_of' && link.ended === null;

/**
 * Every work order with a member: each item others are `part_of`, with those members, open
 * ones first, then by their newest member. Membership is read from both ends of each link:
 * a member's own read, and the order's read, which also names members with no run yet. An
 * order's title is its own read's when that is among `items`. `items` come most recently
 * active first, as the item read pages them.
 */
export function workOrders(items: readonly ItemRead[]): WorkOrder[] {
  const reads = new Map(items.map(read => [read.item.id, read]));
  const orders = new Map<string, { item: ItemRead['item']; members: Map<string, Member> }>();
  const join = (order: ItemRead['item'], member: ItemRead['item']): void => {
    const entry = orders.get(order.id) ?? {
      item: reads.get(order.id)?.item ?? order,
      members: new Map<string, Member>(),
    };
    entry.members.set(member.id, { item: member, read: reads.get(member.id) });
    orders.set(order.id, entry);
  };
  for (const read of items) {
    const order = orderOf(read);
    if (order !== undefined) join(order, read.item);
  }
  for (const read of items)
    for (const link of read.links)
      if (activePartOf(link) && link.direction === 'incoming') join(read.item, link.other);
  const listed = [...orders.values()].map(({ item, members }) => ({
    item,
    members: [...members.values()],
  }));
  const open = (order: WorkOrder): boolean => order.members.some(isOpenMember);
  // Stable, so orders keep their newest member's order within open and the rest.
  return listed.sort((a, b) => Number(open(b)) - Number(open(a)));
}

const isOpenMember = (member: Member): boolean =>
  member.read !== undefined && isMoving(member.read);

/**
 * Every item of a project, and the read of each work order among their links that has no
 * run of its own, so the window does not list it: its links name the members with no run.
 */
async function listOrderItems(projectId: string): Promise<ItemRead[]> {
  const items = await listItems(projectId, ITEM_STATES);
  const read = new Set(items.map(item => item.item.id));
  const missing = new Map(
    items.flatMap(item => {
      const order = orderOf(item);
      return order === undefined || read.has(order.id) ? [] : [[order.id, order.key] as const];
    })
  );
  const orders = await Promise.all([...missing.values()].map(key => getItem(projectId, key)));
  return [...items, ...orders];
}

const isMoving = (read: ItemRead): boolean =>
  (MOVING as readonly string[]).includes(read.standing.state);

/**
 * The work orders, each with how many of its members merged and what its open members are
 * doing. Choosing one with open members keeps the board to them. Until every item is read
 * (`counted`), the orders come from the open items alone, so no merged count is shown.
 */
function WorkOrderStrip({
  orders,
  counted,
  error,
  chosen,
  choose,
}: {
  orders: WorkOrder[];
  counted: boolean;
  error: Error | undefined;
  chosen: string | null;
  choose: (order: string) => void;
}): ReactElement | null {
  if (orders.length === 0 && error === undefined) return null;
  return (
    <section data-work-orders className="mb-6 flex flex-col gap-2">
      {error === undefined ? null : (
        <p className="text-console-12 text-error">
          The work orders could not be read in full: {error.message}
        </p>
      )}
      {orders.map(({ item, members }) => {
        const open = members.flatMap(({ read }) =>
          read !== undefined && isMoving(read) ? [read] : []
        );
        const merged = members.filter(({ read }) => read != null && read.merged !== null).length;
        const unstarted = members.filter(({ read }) => read === undefined).length;
        return (
          <button
            key={item.id}
            type="button"
            data-work-order={item.key}
            aria-pressed={chosen === item.id}
            disabled={open.length === 0}
            onClick={() => {
              choose(item.id);
            }}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded border px-3 py-2 text-left ${chosen === item.id ? 'border-accent bg-surface-elevated' : 'border-border bg-surface hover:bg-surface-hover disabled:hover:bg-surface'}`}
          >
            <span data-work-order-key className="font-mono text-console-11 text-text-tertiary">
              {displayItemKey(item.key)}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
              {item.title ?? 'Work order'}
            </span>
            <span data-work-order-line className="text-console-11 text-text-secondary">
              {[
                ...(counted ? [`${String(merged)} of ${String(members.length)} merged`] : []),
                ...(counted && unstarted > 0 ? [`${String(unstarted)} not started`] : []),
                ...(open.length === 0 ? [] : [`${String(open.length)} open`, stageLine(open)]),
              ].join(' · ')}
            </span>
          </button>
        );
      })}
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
  const [showOutside, setShowOutside] = useState(false);
  const [filter, setFilter] = useState('');
  const [order, setOrder] = useState<string | null>(null);
  // Every item, so an order lists its merged members too; the open ones stand in until it reads.
  const every = useEntity<ItemRead[]>(K.boardOrders(projectId), () => listOrderItems(projectId));
  const all = open.data ?? [];
  const orders = workOrders(every.data ?? all);
  // The filter searches what each card shows: its issue title and its key as a person reads it.
  // The titles are read only once something is typed, so a cold board's first reads are the
  // stage columns' own.
  const wanted = filter.trim().toLowerCase();
  const titles = useForgeTitles(wanted === '' ? null : projectId, all);
  const items = all.filter(
    read =>
      (order === null || orderOf(read)?.id === order || read.item.id === order) &&
      itemMatches(read, titles, wanted)
  );
  const packOf = (read: ItemRead): string | undefined => read.standing.pack ?? undefined;
  const moving = items;
  // Every pack with an item in the project, so a pack with nothing open still shows Done.
  const packs = [
    ...new Set([...(project?.itemPacks ?? []), ...moving.flatMap(read => packOf(read) ?? [])]),
  ].sort();
  const outside = moving.filter(read => packOf(read) === undefined);

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
                : `${String(all.length)} on a stage`}
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
          <input
            type="search"
            value={filter}
            onChange={event => {
              setFilter(event.target.value);
            }}
            aria-label="Filter items"
            placeholder="Filter by key or title"
            className="mb-4 w-full rounded border border-border bg-surface px-3 py-1.5 text-console-12 text-text-primary md:w-80"
          />
          <WorkOrderStrip
            orders={orders}
            counted={every.data !== undefined}
            error={every.error}
            chosen={order}
            choose={id => {
              setOrder(current => (current === id ? null : id));
            }}
          />
          {packs.map(pack => (
            <PackBoard
              key={pack}
              projectId={projectId}
              pack={pack}
              items={moving.filter(read => packOf(read) === pack)}
            />
          ))}
          <DecisionStrip projectId={projectId} />
          {outside.length > 0 ? (
            <section data-outside-pack className="mb-6">
              <button
                type="button"
                aria-expanded={showOutside}
                onClick={() => {
                  setShowOutside(shown => !shown);
                }}
                className="rounded border border-border px-3 py-1.5 text-console-12 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              >
                {showOutside ? 'Hide' : 'Show'} {outside.length} open on no pack stage
              </button>
              {showOutside ? (
                <CardList
                  reads={outside}
                  projectId={projectId}
                  className="mt-3 grid gap-2 md:grid-cols-3"
                />
              ) : null}
            </section>
          ) : null}
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
