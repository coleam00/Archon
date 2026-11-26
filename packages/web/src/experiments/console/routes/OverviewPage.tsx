/**
 * A project's staged packs at a glance: what the pack says it is, how much is moving, how many
 * asks wait on the operator, and where the items sit in the pack's flow.
 *
 * The page decides nothing and names no pack. The pack's name, document, groups and arrows come
 * from the pack graph read; where an item is comes from the item read's `standing` and
 * `placeFor`, the same placement the board draws. Its numbers are `packBoard`'s over the board's
 * own every-item read, so they match the board. Of the asks it shows only their count, as one
 * link to the project's Needs you tab: Needs you is drawn on that tab and on Archon's
 * platform-wide Needs you page, nowhere else (#218).
 *
 * The map is `factory/PackMap.tsx`'s: the pack's curated map when it ships a view file, else the
 * flow derived from the graph.
 */
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router';
import { useItemAsks } from '../components/ItemAsksSection';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { FactoryNumbers } from '../factory/FactoryNumbers';
import { askReadOf, type AskRead } from '../factory/lib/item-asks';
import { packBoard, placeFor } from '../factory/lib/board-numbers';
import { PackMap, usePackView } from '../factory/PackMap';
import { useBoardItems } from '../factory/useBoardItems';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import { getPackGraph, type ItemRead, type PackGraph } from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { isMoving } from './board/standing';

/**
 * The project's open asks as one line linking to its Needs you tab. Nothing while the asks are
 * read, so it never claims nothing waits before it knows, and nothing when none is open (the
 * need-you tile beside it already says 0).
 */
export function NeedsYouLine({
  projectId,
  count,
}: {
  projectId: string;
  /** The project's open asks; undefined until the attention list answers. */
  count: number | undefined;
}): ReactElement | null {
  if (count === undefined || count === 0) return null;
  return (
    <p data-needs-you>
      <Link
        to={`/console/p/${projectId}/needs-you`}
        className="text-console-13 text-accent-bright underline"
      >
        {String(count)} {count === 1 ? 'needs you' : 'need you'}
      </Link>
    </p>
  );
}

export function PackOverview({
  projectId,
  pack,
  items,
  itemsError,
  needYou,
  asks,
  children,
}: {
  projectId: string;
  pack: string;
  /** Every item of the project, as the board reads them; undefined while they are read. */
  items: ItemRead[] | undefined;
  itemsError: Error | undefined;
  /** The project's open asks; undefined until the attention list answers. */
  needYou: number | undefined;
  /** The project's asks, which the map counts per stage (`PackMap`). */
  asks: AskRead;
  /** The Needs you line, drawn under the tiles and above the map (DESIGN.md, Overview page). */
  children?: ReactNode;
}): ReactElement {
  const { data: graph, error } = useEntity<PackGraph>(K.packGraph(projectId, pack), () =>
    getPackGraph(projectId, pack)
  );
  // The view under the key the map reads it with, so placing items adds no read.
  const view = usePackView(projectId, pack);
  const settled = view.data !== undefined || view.error !== undefined;
  const place =
    graph === undefined || !settled ? undefined : placeFor(graph.stages, view.data?.view ?? null);
  const board = items === undefined ? undefined : packBoard(items, pack, new Date(), place);
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
      <PackMap
        projectId={projectId}
        pack={pack}
        board={board}
        itemsError={itemsError}
        asks={asks}
      />
    </section>
  );
}

export function OverviewPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const project = projects?.find(candidate => candidate.id === projectId);
  const packs = project?.itemPacks ?? [];
  const { data: attention, error: attentionError } = useEntity<skill.RunsAttention>(
    K.runsAttention,
    skill.listRunsNeedingAttention
  );
  const itemAsks = useItemAsks(attention, projectId);
  // The board's every-item read, under its key: opening one page after the other reads once,
  // and the items on a stage are its open ones.
  const every = useBoardItems(projectId);
  const open = { data: every.data?.filter(isMoving), error: every.error };
  // The tile counts asks, the Needs you tab's number, including asks on items at no stage; the
  // map counts items with asks per stage (`PackMap`), so the two can differ on purpose.
  const needYou = attention === undefined ? undefined : itemAsks.asks.length;
  const asks = askReadOf(attention, attentionError, itemAsks);
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
            needYou={needYou}
            asks={asks}
          >
            {/* The count is the project's, so it is drawn once, under the first pack's tiles. */}
            {index === 0 ? <NeedsYouLine projectId={projectId} count={needYou} /> : null}
          </PackOverview>
        ))}
      </div>
    </section>
  );
}
