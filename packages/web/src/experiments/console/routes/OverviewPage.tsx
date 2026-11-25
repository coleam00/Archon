/**
 * A project's staged packs at a glance: what the pack says it is, how much is moving, what
 * waits on the operator, and where the items sit in the pack's flow.
 *
 * The page decides nothing and names no pack. The pack's name, document, groups, arrows and
 * metric cards come from the pack graph read; where an item is comes from the item read's
 * `standing`, the same placement the board draws; the asks are the attention list's. Its
 * numbers are `packBoard`'s over the board's own every-item read, so they match the board.
 *
 * The map is `factory/PackMap.tsx`'s: the pack's curated map when it ships a view file, else the
 * flow derived from the graph.
 */
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router';
import { ItemAsksSection, useItemAsks } from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { FactoryNumbers } from '../factory/FactoryNumbers';
import { packBoard } from '../factory/lib/board-numbers';
import { PackMap } from '../factory/PackMap';
import { useBoardItems } from '../factory/useBoardItems';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import { getPackGraph, listItems, type ItemRead, type PackGraph } from '../skills/items';
import type { MetricsReport } from '../skills/metrics';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { MOVING } from './BoardPage';
import { MetricCards } from './metrics/MetricsOverview';
import { metricsRequests } from './metrics/model';

const HEADLINE_CARDS = 3;
const HEADLINE_DAYS = 7;
const TOP_ASKS = 3;

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

export function PackOverview({
  projectId,
  pack,
  items,
  itemsError,
  needYou,
  children,
}: {
  projectId: string;
  pack: string;
  /** Every item of the project, as the board reads them; undefined while they are read. */
  items: ItemRead[] | undefined;
  itemsError: Error | undefined;
  /** The project's open asks; undefined until the attention list answers. */
  needYou: number | undefined;
  /** The top asks, drawn under the tiles and above the map (DESIGN.md, Overview page). */
  children?: ReactNode;
}): ReactElement {
  const { data: graph, error } = useEntity<PackGraph>(K.packGraph(projectId, pack), () =>
    getPackGraph(projectId, pack)
  );
  const board = items === undefined ? undefined : packBoard(items, pack, new Date());
  const heading = 'text-sm font-medium text-text-primary';
  // As on the board: a pack with nothing on its board has nothing to show.
  if (board !== undefined && board.onBoard.length === 0) return <></>;
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

      <FactoryNumbers numbers={board?.numbers} needYou={needYou} error={itemsError} />
      {children}
      <PackMap projectId={projectId} pack={pack} board={board} itemsError={itemsError} />
      {graph?.metricViews == null ? null : (
        <Headline projectId={projectId} views={graph.metricViews} />
      )}
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
  const every = useBoardItems(projectId);
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
            items={every.data}
            itemsError={every.error}
            needYou={attention === undefined ? undefined : itemAsks.asks.length}
          >
            {index === 0 ? topAsks : null}
          </PackOverview>
        ))}
      </div>
    </section>
  );
}
