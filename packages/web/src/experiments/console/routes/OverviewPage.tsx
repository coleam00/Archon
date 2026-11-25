/**
 * A project's staged packs at a glance: what the pack says it is, how much is moving, what
 * waits on the operator, and where the items sit in the pack's flow.
 *
 * The page decides nothing and names no pack. The pack's name, document, groups, arrows and
 * metric cards come from the pack graph read; where an item is comes from the item read's
 * `standing`, the same placement the board draws; the asks are the attention list's.
 */
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router';
import { ItemAsksSection, useItemAsks } from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { relativeTime } from '../lib/format';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import {
  getPackGraph,
  ITEM_STATES,
  listItems,
  listItemsPage,
  type ItemPage,
  type ItemRead,
  type PackGraph,
} from '../skills/items';
import type { MetricsReport } from '../skills/metrics';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { MOVING, chipOf, columnsOf, newestDone, standingRun, type StageGroup } from './BoardPage';
import { MetricCards } from './metrics/MetricsOverview';
import { metricsRequests } from './metrics/model';

const HEADLINE_CARDS = 3;
const HEADLINE_DAYS = 7;
const TOP_ASKS = 3;
const TODAY_LIMIT = 100;

/** The start of the operator's day, as the instant the item window reads from. */
export function startOfToday(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** How many of a pack's items sit in each column, and how many of those wait on the operator. */
export function flowCounts(
  columns: readonly StageGroup[],
  items: readonly ItemRead[]
): { name: string; stages: string[]; count: number; needYou: number }[] {
  return columns.map(column => {
    const here = items.filter(read =>
      column.stages.includes(standingRun(read)?.pack?.workflow ?? '')
    );
    return {
      ...column,
      count: here.length,
      needYou: here.filter(read => chipOf(read) === 'needs_you').length,
    };
  });
}

/** What today's read says: items first started today, and items whose change merged today. */
export function todayCounts(
  page: Pick<ItemPage, 'items'> | undefined,
  since: string
): { entered: number; landed: number } {
  const items = page?.items ?? [];
  const start = Date.parse(since);
  return {
    entered: items.filter(read => Date.parse(read.runs[0]?.startedAt ?? '') >= start).length,
    landed: items.filter(read => read.merged !== null && Date.parse(read.merged.at) >= start)
      .length,
  };
}

function Tile({
  name,
  label,
  value,
  children,
}: {
  name: string;
  label: string;
  value: number;
  children?: ReactNode;
}): ReactElement {
  return (
    <div data-number={name} className="rounded-console-12 border border-border px-5 py-4">
      <h3 className="text-console-12 font-medium text-text-secondary">{label}</h3>
      <p data-value className="mt-2 text-2xl font-medium tabular-nums text-text-primary">
        {value}
      </p>
      <p className="mt-1 text-console-11 text-text-tertiary">{children}</p>
    </div>
  );
}

/** The pack's own numbers: the first cards it declares, over the last week of its metrics. */
function Headline({
  projectId,
  views,
}: {
  projectId: string;
  views: NonNullable<PackGraph['metricViews']>;
}): ReactElement | null {
  const cards = views.cards.slice(0, HEADLINE_CARDS);
  // The metrics queries are made only for a pack that declares cards.
  const requests = metricsRequests(projectId, HEADLINE_DAYS);
  const idle = cards.length === 0;
  const report = useEntity<MetricsReport | undefined>(
    idle ? 'noop:overview-no-cards' : requests.report.key,
    idle ? () => Promise.resolve(undefined) : requests.report.load
  );
  const calibrated = cards.some(card => card.shape === 'ratio' && card.calibration !== undefined);
  const calibration = useEntity<MetricsReport | undefined>(
    calibrated ? requests.calibration.key : 'noop:overview-no-calibration',
    calibrated ? requests.calibration.load : () => Promise.resolve(undefined)
  );
  if (views.problem !== null)
    return (
      <p data-cards-problem className="text-console-12 text-warning">
        The pack's metric cards could not be read: {views.problem}
      </p>
    );
  if (idle) return null;
  return (
    <div data-headline>
      <p className="mb-2 text-console-11 text-text-tertiary">
        The pack's own numbers, last {HEADLINE_DAYS} days
        {report.error !== undefined ? `: ${report.error.message}` : ''}
      </p>
      <MetricCards
        cards={cards}
        report={report.data}
        calibrations={
          calibration.data !== undefined
            ? { state: 'loaded', report: calibration.data }
            : calibration.error !== undefined
              ? { state: 'failed', message: calibration.error.message }
              : { state: 'loading' }
        }
        names={new Map(Object.entries(views.names))}
        detailsPath={`/console/p/${projectId}/metrics/details`}
      />
    </div>
  );
}

/** The pack's columns as a row of boxes with their counts, then the board's Done. */
function Flow({
  board,
  flow,
  done,
  landed,
}: {
  board: string;
  flow: ReturnType<typeof flowCounts>;
  done: number;
  landed: number;
}): ReactElement {
  return (
    <div data-flow>
      <h2 className="text-sm font-medium text-text-primary">The flow</h2>
      <ol className="mt-3 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-stretch">
        {flow.map(column => (
          <li key={column.name} className="flex items-center gap-2">
            <Link
              data-flow-group={column.name}
              to={`${board}?group=${encodeURIComponent(column.name)}`}
              className="block min-w-36 rounded-console-12 border border-border px-4 py-3 hover:border-border-bright"
            >
              <span className="text-console-12 font-medium text-text-secondary">{column.name}</span>
              <span data-count className="ml-2 text-base tabular-nums text-text-primary">
                {column.count}
              </span>
              <span className="mt-1 block font-mono text-console-10 text-text-tertiary">
                {column.stages.join(' · ')}
              </span>
              {column.needYou > 0 ? (
                <span data-need-you className="mt-1 block text-console-11 text-warning">
                  {column.needYou} need you
                </span>
              ) : null}
            </Link>
            <span aria-hidden className="text-text-tertiary">
              →
            </span>
          </li>
        ))}
        <li>
          <Link
            data-flow-group="done"
            to={board}
            className="block min-w-36 rounded-console-12 border border-border px-4 py-3 hover:border-border-bright"
          >
            <span className="text-console-12 font-medium text-text-secondary">Done</span>
            <span data-count className="ml-2 text-base tabular-nums text-text-primary">
              {done}
            </span>
            <span className="mt-1 block text-console-11 text-text-tertiary">
              {landed} landed today
            </span>
          </Link>
        </li>
      </ol>
    </div>
  );
}

function PackOverview({
  projectId,
  pack,
  moving,
  asks,
  children,
}: {
  projectId: string;
  pack: string;
  moving: ItemRead[];
  asks: { count: number; oldest: string | undefined };
  /** The top asks, drawn under the flow and the pack's numbers. */
  children?: ReactNode;
}): ReactElement {
  const { data: graph, error } = useEntity<PackGraph>(K.packGraph(projectId, pack), () =>
    getPackGraph(projectId, pack)
  );
  const done = useEntity<ItemPage>(K.boardDone(projectId, pack), () => newestDone(projectId, pack));
  const since = startOfToday();
  const today = useEntity<ItemPage>(K.boardSince(projectId, pack, since), () =>
    listItemsPage(projectId, ITEM_STATES, { pack, since, limit: TODAY_LIMIT })
  );
  const columns = columnsOf(graph);
  const counts = todayCounts(today.data, since);
  const running = moving.filter(read => read.standing.state === 'running').length;
  const queued = moving.filter(read => read.standing.state === 'queued').length;
  const heading = 'text-sm font-medium text-text-primary';
  // As on the board: a pack with nothing on a stage and nothing done has nothing to show.
  if (moving.length === 0 && done.data?.totals?.done === 0) return <></>;
  return (
    <section data-pack={pack} className="mb-10 flex flex-col gap-6">
      <div>
        <h2 className={heading}>{pack}</h2>
        {error !== undefined ? (
          <p className="mt-1 text-console-12 text-error">{error.message}</p>
        ) : null}
        {graph?.document != null && graph.document.text !== '' ? (
          <div
            data-document
            className="mt-2 line-clamp-4 max-w-3xl text-console-12 text-text-secondary [&_h1]:font-medium [&_h1]:text-text-primary"
          >
            <ReactMarkdown>{graph.document.text}</ReactMarkdown>
          </div>
        ) : null}
      </div>

      <div data-numbers className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Tile name="in-flight" label="In flight" value={moving.length}>
          {running} running · {queued} queued · {moving.length - running - queued} waiting
        </Tile>
        <Tile name="need-you" label="Need you" value={asks.count}>
          {asks.oldest === undefined ? 'nothing waits' : `oldest ${relativeTime(asks.oldest)}`}
        </Tile>
        <Tile name="landed-today" label="Landed today" value={counts.landed}>
          {today.error !== undefined
            ? today.error.message
            : `${String(counts.entered)} entered today${today.data?.next != null ? ', of the first read' : ''}`}
        </Tile>
      </div>
      <Flow
        board={`/console/p/${projectId}/board`}
        flow={flowCounts(columns, moving)}
        done={done.data?.totals?.done ?? 0}
        landed={counts.landed}
      />
      {graph?.metricViews == null ? null : (
        <Headline projectId={projectId} views={graph.metricViews} />
      )}
      {children}
    </section>
  );
}

export function OverviewPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const project = projects?.find(candidate => candidate.id === projectId);
  const packs = project?.itemPacks ?? [];
  // The same read, under the same key, as the board: opening one after the other reads once.
  const open = useEntity<ItemRead[]>(K.board(projectId), () => listItems(projectId, MOVING));
  const { data: attention } = useEntity<skill.RunsAttention>(
    K.runsAttention,
    skill.listRunsNeedingAttention
  );
  const itemAsks = useItemAsks(attention, projectId);
  const waits = itemAsks.asks.flatMap(ask => ask.pausedAt ?? []).sort();
  const asks = { count: itemAsks.asks.length, oldest: waits[0] };
  const topAsks =
    itemAsks.asks.length + itemAsks.answered.length > 0 ? (
      <section data-needs-you>
        <h2 className="text-sm font-medium text-text-primary">Needs you</h2>
        <div className="mt-3 flex flex-col gap-3">
          <ItemAsksSection
            {...itemAsks}
            asks={itemAsks.asks.slice(0, TOP_ASKS)}
            showProject={false}
            compact={{ openAt: `/console/p/${projectId}/board` }}
          />
        </div>
        {itemAsks.asks.length > TOP_ASKS ? (
          <Link
            to="/console/needs-you"
            className="mt-2 inline-block text-console-12 text-accent-bright underline"
          >
            {itemAsks.asks.length - TOP_ASKS} more on Needs you
          </Link>
        ) : null}
      </section>
    ) : null;
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
        <ProjectViewTabs projectId={projectId} active="overview" />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-5 md:px-6">
        {packs.map((pack, index) => (
          <PackOverview
            key={pack}
            projectId={projectId}
            pack={pack}
            moving={(open.data ?? []).filter(read => read.standing.pack === pack)}
            asks={asks}
          >
            {index === 0 ? topAsks : null}
          </PackOverview>
        ))}
      </div>
    </section>
  );
}
