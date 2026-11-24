/**
 * The board of a project that runs a staged pack: its open items under the stage each is
 * on, the asks that wait on them, and the items at rest behind a control.
 *
 * It decides nothing. Where an item is and whether it is open is the item read's
 * `standing`, the stages and their order are the pack graph's, and an ask is drawn and
 * answered by the component the runs page uses.
 */
import { useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router';
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

/** Every state but the two an item ends in. */
const OPEN = ['running', 'waiting', 'queued', 'failed', 'stopped'] as const;

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
function chipOf(read: ItemRead): Chip {
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
function standingRun(read: ItemRead): ItemRead['runs'][number] | undefined {
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

function ItemCard({ read, projectId }: { read: ItemRead; projectId: string }): ReactElement {
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
          {CHIP[chip].label}
        </span>
      </div>
      <p className="mt-1 text-console-11 text-text-tertiary">
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

/** What the items of a stage are doing, as counts: `1 needs you · 2 running`. */
function stageLine(items: ItemRead[]): string {
  return (Object.keys(CHIP) as Chip[])
    .flatMap(chip => {
      const count = items.filter(read => chipOf(read) === chip).length;
      return count === 0 ? [] : [`${String(count)} ${CHIP[chip].label.toLowerCase()}`];
    })
    .join(' · ');
}

/**
 * One stage with its items. An empty stage collapses to a narrow heading, so the pack's
 * order still shows and the occupied stages stay on screen.
 */
function Stage({
  name,
  items,
  projectId,
}: {
  name: string;
  items: ItemRead[];
  projectId: string;
}): ReactElement {
  const empty = items.length === 0;
  return (
    <div
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
            <ItemCard key={read.item.id} read={read} projectId={projectId} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A pack's stages in the graph's order, each with the open items standing at it. */
function PackBoard({
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
  const stageOf = (read: ItemRead): string | undefined => standingRun(read)?.pack?.workflow;
  // A workflow of the pack that only other workflows call is not a stage an item stands at.
  const stages = (graph?.stages ?? []).filter(stage => stage.inFlow);
  // An item whose stage the pack no longer has, or whose pack could not be read, stays visible.
  const offStage = items.filter(read => !stages.some(stage => stage.workflow === stageOf(read)));
  return (
    <section data-pack={pack} className="mb-6">
      <h2 className="text-sm font-medium text-text-primary">{pack}</h2>
      {error !== undefined ? (
        <p className="mt-1 text-console-12 text-error">{error.message}</p>
      ) : null}
      {graph === undefined && error === undefined ? (
        <p className="mt-2 text-console-12 text-text-tertiary">Loading stages…</p>
      ) : (
        <div className="mt-3 flex flex-col gap-4 md:flex-row md:overflow-x-auto md:pb-2">
          {stages.map(stage => (
            <Stage
              key={stage.name}
              name={stage.workflow}
              items={items.filter(read => stageOf(read) === stage.workflow)}
              projectId={projectId}
            />
          ))}
          {offStage.length > 0 ? (
            <Stage name="Not on a stage" items={offStage} projectId={projectId} />
          ) : null}
        </div>
      )}
    </section>
  );
}

/** The items nothing runs, is queued or waits on: read a page at a time, when asked for. */
function RestingItems({ projectId }: { projectId: string }): ReactElement {
  const [page, setPage] = useState<ItemPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await listItemsPage(projectId, ['done', 'resting'], {
        after: page?.next ?? undefined,
      });
      setPage({ ...next, items: [...(page?.items ?? []), ...next.items] });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'The items could not be read.');
    } finally {
      setBusy(false);
    }
  };
  const more = page === null || page.next !== null;
  return (
    <section data-resting className="mt-8 border-t border-border pt-4">
      <h2 className="text-sm font-medium text-text-primary">Items at rest</h2>
      <p className="mt-1 text-console-12 text-text-tertiary">
        Nothing runs, is queued or waits on these. A merged item is one of them.
      </p>
      {page !== null && page.items.length > 0 ? (
        <ul className="mt-3 grid gap-2 md:grid-cols-3">
          {page.items.map(read => (
            <ItemCard key={read.item.id} read={read} projectId={projectId} />
          ))}
        </ul>
      ) : null}
      {page !== null && page.items.length === 0 && !more ? (
        <p className="mt-2 text-console-12 text-text-tertiary">None.</p>
      ) : null}
      {error !== null ? <p className="mt-2 text-console-12 text-error">{error}</p> : null}
      {more ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="mt-3 rounded border border-border px-3 py-1.5 text-console-12 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
        >
          {busy ? 'Reading…' : page === null ? 'Show items at rest' : 'Show more'}
        </button>
      ) : null}
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
  const open = useEntity<ItemRead[]>(K.board(projectId), () => listItems(projectId, OPEN));
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
  // An item that needs a decision is not on a stage: it sits in its own strip until a newer run.
  const decide = items.filter(needsDecision);
  const moving = items.filter(read => !needsDecision(read));
  const packs = [...new Set(moving.flatMap(read => packOf(read) ?? []))].sort();
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
                : `${String(all.length)} open`}
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
        {decide.length > 0 ? (
          <section data-needs-decision className="mb-6">
            <h2 className="text-sm font-medium text-text-primary">
              Failed or stopped: needs a decision
            </h2>
            <p className="mt-1 text-console-12 text-text-tertiary">
              Nothing moves these until a new run starts on them.
            </p>
            <ul className="mt-3 grid gap-2 md:grid-cols-3">
              {decide.map(read => (
                <ItemCard key={read.item.id} read={read} projectId={projectId} />
              ))}
            </ul>
          </section>
        ) : null}
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
        <RestingItems projectId={projectId} />
      </div>
    </section>
  );
}
