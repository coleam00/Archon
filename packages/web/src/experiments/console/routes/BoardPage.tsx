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
import { ItemAsksSection, itemAsksAnchor, useItemAsks } from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { relativeTime } from '../lib/format';
import type { Project } from '../primitives/project';
import { isItemAsk } from '../primitives/run';
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

type Chip = ItemRead['standing']['state'] | 'needs_you';

/** The states of an item that is on a stage: something runs, is queued or waits on it. */
export const MOVING = ['running', 'waiting', 'queued'] as const;

// The order chips are counted in on a stage heading.
const CHIP: Record<Chip, { label: string; tone: string }> = {
  needs_you: { label: 'Needs you', tone: 'border-warning/50 bg-warning/15 text-warning' },
  running: { label: 'Running', tone: 'border-accent/50 bg-accent/15 text-accent-bright' },
  waiting: { label: 'Waiting', tone: 'border-border bg-surface-elevated text-text-secondary' },
  queued: { label: 'Queued', tone: 'border-border bg-surface-elevated text-text-secondary' },
  failed: { label: 'Failed', tone: 'border-error/50 bg-error/15 text-error' },
  stopped: { label: 'Stopped', tone: 'border-error/50 bg-error/15 text-error' },
  done: { label: 'Done', tone: 'border-success/50 bg-success/15 text-success' },
  resting: { label: 'At rest', tone: 'border-border bg-surface text-text-tertiary' },
};

/** An item that waits on the operator says so, whatever else is true of it. */
export function chipOf(read: ItemRead): Chip {
  const asked = read.questions.some(question => question.kind !== 'stopped');
  return asked && read.standing.state === 'waiting' ? 'needs_you' : read.standing.state;
}

/** The work order an item is part of: the item its active `part_of` link points at. */
function orderOf(read: ItemRead): ItemRead['item'] | undefined {
  return read.links.find(
    link => link.kind === 'part_of' && link.direction === 'outgoing' && link.ended === null
  )?.other;
}

/** The run the engine says the item stands at. */
export function standingRun(read: ItemRead): ItemRead['runs'][number] | undefined {
  return read.runs.find(run => run.id === read.standing.runId);
}

/** Nothing moves a failed or stopped item but a newer run, so an operator has to decide. */
const needsDecision = (read: ItemRead): boolean =>
  read.standing.state === 'failed' || read.standing.state === 'stopped';

/** Why the item needs a decision, in the engine's own facts: what failed, or how its run ended. */
function decisionReason(read: ItemRead): string {
  const run = standingRun(read);
  const stage = run?.pack?.workflow ?? run?.workflow ?? 'A run';
  if (read.standing.state === 'failed') return `${stage} failed`;
  const [stop] = read.questions.flatMap(question =>
    question.kind === 'stopped' ? [question] : []
  );
  if (stop === undefined)
    return `${stage} ended ${run?.outcome ?? 'with no outcome'} and nothing followed`;
  const ended = `${stage} ended ${stop.stoppedIn.outcome} and nothing followed`;
  return stop.summary === null ? ended : `${ended}: ${stop.summary}`;
}

const runPath = (projectId: string, runId: string): string =>
  `/console/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(runId)}`;

function ItemCard({
  read,
  projectId,
  stage,
}: {
  read: ItemRead;
  projectId: string;
  /** The exact stage, shown when the card's column holds more than one. */
  stage?: string;
}): ReactElement {
  const run = standingRun(read);
  const chip = chipOf(read);
  const asks = read.questions.filter(isItemAsk).length;
  const [heldByRun] = read.questions.flatMap(question =>
    'run' in question && question.run !== undefined ? [question.run] : []
  );
  const link = 'text-console-11 underline hover:text-text-primary';
  const reason = needsDecision(read) ? decisionReason(read) : undefined;
  const key = <span className="font-mono text-console-11">{read.item.key}</span>;
  return (
    <li
      data-item={read.item.key}
      data-state={read.standing.state}
      className="rounded border border-border bg-surface px-3 py-2"
    >
      <div className="flex items-start justify-between gap-2">
        <p data-item-title className="min-w-0 text-sm font-medium text-text-primary">
          {read.item.title ?? read.item.key}
        </p>
        <span
          data-chip={chip}
          className={`shrink-0 rounded-full border px-2 py-0.5 text-console-10 font-semibold ${CHIP[chip].tone}`}
        >
          {chip === 'done' ? howItEnded(read) : CHIP[chip].label}
        </span>
      </div>
      <p className="mt-1 text-console-11 text-text-tertiary">
        {stage === undefined ? '' : `${stage} · `}
        {run === undefined ? (
          key
        ) : (
          <Link to={runPath(projectId, run.id)} className="underline hover:text-text-primary">
            {key}
          </Link>
        )}
        {run === undefined
          ? ''
          : ` · ${run.outcome === null ? run.status : `ended ${run.outcome}`} · ${relativeTime(run.completedAt ?? run.startedAt)}`}
        {read.merged === null ? '' : ' · merged'}
      </p>
      {reason === undefined ? null : (
        <p data-item-reason className="mt-1 text-console-11 text-text-secondary">
          {reason}
        </p>
      )}
      {asks > 0 ? (
        <a href={`#${itemAsksAnchor(read.item.id)}`} className={`${link} text-warning`}>
          {asks === 1 ? '1 ask waits on you' : `${String(asks)} asks wait on you`}
        </a>
      ) : null}
      {heldByRun !== undefined ? (
        <Link to={runPath(projectId, heldByRun.id)} className={`${link} block text-warning`}>
          Its run waits for an answer
        </Link>
      ) : null}
    </li>
  );
}

/** How a done item ended, in the engine's facts: its change merged, or its run's final outcome. */
function howItEnded(read: ItemRead): string {
  if (read.merged !== null) return 'Merged';
  return standingRun(read)?.outcome ?? CHIP.done.label;
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
        <ul className="mt-2 flex flex-col gap-2">
          {items.map(read => (
            <ItemCard
              key={read.item.id}
              read={read}
              projectId={projectId}
              stage={stageOf?.(read)}
            />
          ))}
        </ul>
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
      <ul className="mt-2 flex flex-col gap-2">
        {list.shown.map(read => (
          <ItemCard key={read.item.id} read={read} projectId={projectId} />
        ))}
      </ul>
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
        Nothing moves these until a new run starts on them.
      </p>
      <ul className="mt-3 grid gap-2 md:grid-cols-3">
        {list.shown.map(read => (
          <ItemCard key={read.item.id} read={read} projectId={projectId} />
        ))}
      </ul>
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
  const stageOf = (read: ItemRead): string | undefined => standingRun(read)?.pack?.workflow;
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

/**
 * The work orders with a member open: each item that open items are `part_of`, with those
 * members. A member at rest is not in the open list, so only open members are counted.
 */
function workOrders(items: ItemRead[]): { item: ItemRead['item']; members: ItemRead[] }[] {
  const orders = new Map<string, { item: ItemRead['item']; members: ItemRead[] }>();
  for (const read of items) {
    const item = orderOf(read);
    if (item === undefined) continue;
    const order = orders.get(item.id) ?? { item, members: [] };
    order.members.push(read);
    orders.set(item.id, order);
  }
  return [...orders.values()];
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
  const all = open.data ?? [];
  const orders = workOrders(all);
  const wanted = filter.trim().toLowerCase();
  const items = all.filter(
    read =>
      (order === null || orderOf(read)?.id === order || read.item.id === order) &&
      (wanted === '' ||
        read.item.key.toLowerCase().includes(wanted) ||
        (read.item.title ?? '').toLowerCase().includes(wanted))
  );
  const packOf = (read: ItemRead): string | undefined => standingRun(read)?.pack?.key;
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
        {orders.length > 0 ? (
          <section data-work-orders className="mb-6 flex flex-col gap-2">
            {orders.map(({ item, members }) => (
              <button
                key={item.id}
                type="button"
                data-work-order={item.key}
                aria-pressed={order === item.id}
                onClick={() => {
                  setOrder(current => (current === item.id ? null : item.id));
                }}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded border px-3 py-2 text-left ${order === item.id ? 'border-accent bg-surface-elevated' : 'border-border bg-surface hover:bg-surface-hover'}`}
              >
                <span className="font-mono text-console-11 text-text-tertiary">{item.key}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {item.title ?? 'Work order'}
                </span>
                <span className="text-console-11 text-text-secondary">
                  {members.length} open · {stageLine(members)}
                </span>
              </button>
            ))}
          </section>
        ) : null}
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
              <ul className="mt-3 grid gap-2 md:grid-cols-3">
                {outside.map(read => (
                  <ItemCard key={read.item.id} read={read} projectId={projectId} />
                ))}
              </ul>
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
    </section>
  );
}
