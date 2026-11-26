/**
 * A pack's map on the project Overview: the curated map, laid out from the pack graph and
 * worded by the pack's view file, whenever the server could read that file, with what the file
 * gets wrong listed above it; else the map derived from the pack graph (`mapSource`, the one
 * place that chooses). The curated map offers the derived one as "Full workflow"
 * (`?map=full`). The routes import the factory's map through this file only.
 */
import { useMemo, type ReactElement, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { columnsOf } from '../routes/BoardPage';
import type { PackGraph } from '../skills/items';
import { useEntity, type EntityView } from '../store/cache';
import { K } from '../store/keys';
import { getPackViewRead, type FactoryView, type PackView } from './api';
import { DerivedFlow, flowCounts, stageCounts } from './DerivedFlow';
import { FactoryCardsProvider } from './FactoryCards';
import { GraphSkeleton } from './GraphSkeleton';
import { curatedView } from './lib/curated-view';
import { retiredOf } from './lib/item-card';
import { mapSource } from './lib/map-source';
import { groupsOf } from './lib/view-groups';
import type { PackBoardGroups } from './lib/board-numbers';
import type { AskRead } from './lib/item-asks';
import { stageLive, type MapLive, type Unread } from './lib/map-live';
import { CuratedMap } from './map/CuratedMap';
import { useMapStructure, usePackGraph } from './map-structure';
import { ReadFailure } from './ReadFailure';
import { SegmentedControl } from './ui/SegmentedControl';
import { DocumentProblems, ViewProblems } from './ViewProblems';

/** The search param that shows the derived map in place of the curated one. */
const MAP_PARAM = 'map';
const FULL = 'full';

/**
 * Whether the page shows the derived map as "Full workflow" (`?map=full`), and the handler a
 * segment calls to choose it or the curated map. The Overview and How it works share it.
 */
export function useFullWorkflow(): [boolean, (next: boolean) => () => void] {
  const [params, setParams] = useSearchParams();
  const choose = (next: boolean) => (): void =>
    setParams(current => {
      const kept = new URLSearchParams(current);
      if (next) kept.set(MAP_PARAM, FULL);
      else kept.delete(MAP_PARAM);
      return kept;
    });
  return [params.get(MAP_PARAM) === FULL, choose];
}

/** The view read of a pack, under its one cache key. */
export function usePackView(projectId: string, pack: string): EntityView<PackView> {
  return useEntity(K.packView(projectId, pack), () => getPackViewRead(projectId, pack));
}

interface PackMapProps {
  projectId: string;
  pack: string;
  /**
   * The pack's board, as the Board and the Overview's tiles group it (`packBoard`): its moving
   * items, its Merged column and its numbers. Undefined while every item is read.
   */
  board: PackBoardGroups | undefined;
  /** The every-item read failed. */
  itemsError: Error | undefined;
  /** The project's asks, which the map counts by the board cards' rule (`lib/item-asks.ts`). */
  asks: AskRead;
}

const HEADING = 'text-console-12 font-medium uppercase tracking-console-label text-text-tertiary';

export function PackMap({ projectId, pack, board, itemsError, asks }: PackMapProps): ReactElement {
  const viewRead = usePackView(projectId, pack);
  const source = mapSource(viewRead);
  const graph = usePackGraph(projectId, pack);
  const retired = retiredOf(viewRead.data?.view);
  const [full, choose] = useFullWorkflow();
  const boardPath = `/console/p/${encodeURIComponent(projectId)}/board`;
  // The derived map's columns are the same groups the curated map draws, so a card's heading
  // is its group's on both.
  const view = source.kind === 'curated' ? source.view : null;
  const groups = groupsOf(graph.data);
  const derived = (
    <DerivedFlow
      flow={flowCounts(
        columnsOf(graph.data, groups, view),
        board?.moving ?? [],
        graph.data?.stages,
        asks,
        retired
      )}
      graph={graph.data}
      view={view}
      counts={stageCounts(board?.moving ?? [], graph.data?.stages, asks, retired)}
      live={{ board: boardPath, numbers: board?.numbers, failed: itemsError !== undefined }}
    />
  );
  if (source.kind === 'loading')
    return (
      <MapSection>
        <GraphSkeleton label="Loading the map" />
      </MapSection>
    );
  // Without a curated file the Overview draws the derived map as it always has, under its own
  // heading, with the reason a broken file is not drawn above it.
  if (source.kind === 'derived')
    return (
      <div data-pack-map className="flex flex-col gap-2.5">
        {source.note === null ? null : (
          <p data-map-note className="text-console-12 text-warning">
            {source.note}
          </p>
        )}
        <ViewProblems problems={source.problems} drawn={false} />
        <DocumentProblems graph={graph.data} />
        {derived}
      </div>
    );
  return (
    <MapSection
      control={
        <SegmentedControl
          label="Which map"
          active={full ? 'full' : 'map'}
          segments={[
            { key: 'map', label: 'Map', onSelect: choose(false) },
            { key: 'full', label: 'Full workflow', onSelect: choose(true) },
          ]}
        />
      }
    >
      <ViewProblems problems={source.problems} drawn />
      <DocumentProblems graph={graph.data} />
      {full ? (
        derived
      ) : (
        <Curated
          projectId={projectId}
          pack={pack}
          file={source.view}
          graph={graph}
          board={board}
          itemsError={itemsError}
          boardPath={boardPath}
          asks={asks}
        />
      )}
    </MapSection>
  );
}

function MapSection({
  control,
  children,
}: {
  control?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section aria-label="The map" data-pack-map className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <h3 className={HEADING}>The map</h3>
        {control}
      </div>
      {children}
    </section>
  );
}

/** The curated map, once the graph its columns and arrows come from is read. */
function Curated({
  projectId,
  pack,
  file,
  graph,
  board,
  itemsError,
  boardPath,
  asks,
}: {
  projectId: string;
  pack: string;
  file: FactoryView;
  graph: EntityView<PackGraph>;
  board: PackBoardGroups | undefined;
  itemsError: Error | undefined;
  boardPath: string;
  asks: AskRead;
}): ReactElement {
  const view = useMemo(
    () => (graph.data === undefined ? undefined : curatedView(file, graph.data)),
    [file, graph.data]
  );
  const structure = useMapStructure(graph, view);
  const live: MapLive | Unread = useMemo(() => {
    if (view === undefined || board === undefined)
      return itemsError === undefined ? 'loading' : 'failed';
    // The Merged card is the Board's Merged column: the items it lists, so the same count.
    return stageLive(
      view,
      board.moving,
      board.merged.recent,
      graph.data?.stages,
      asks,
      retiredOf(file)
    );
  }, [view, board, itemsError, graph.data, file, asks]);
  if (view === undefined)
    return graph.error === undefined ? (
      <GraphSkeleton label="Loading the map" />
    ) : (
      <ReadFailure retry={graph.refetch}>
        The map could not read the pack's graph: {graph.error.message}
      </ReadFailure>
    );
  // The board cards' reads, under the board's keys: an item's title, the step its run works now
  // and whether it has open asks come from the same place the Board's card takes them
  // (`useCardList` in StageItems).
  return (
    <FactoryCardsProvider projectId={projectId} packs={[pack]} itemAsks={asks}>
      {itemsError === undefined ? null : (
        <p role="alert" className="text-console-13 text-error">
          The pack's items could not be read: {itemsError.message}
        </p>
      )}
      <CuratedMap
        projectId={projectId}
        view={view}
        structure={structure}
        live={live}
        board={boardPath}
      />
    </FactoryCardsProvider>
  );
}
