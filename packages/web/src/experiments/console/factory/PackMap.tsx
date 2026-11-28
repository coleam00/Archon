/**
 * A pack's map on the project Overview, drawn from the pack graph alone. A pack whose document
 * declares groups (`groupsOf`) gets the grouped map, laid out and worded from the graph
 * (`curatedView`, `graph-view.ts`), with its stage modal, and offers the flow derived from the
 * graph as "Full workflow" (`?map=full`). A pack with no groups gets the derived flow. The
 * document's problems are listed above either. The routes import the factory's map through this
 * file only.
 */
import { useMemo, type ReactElement, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { columnsOf } from '../routes/BoardPage';
import type { PackGraph } from '../skills/items';
import type { EntityView } from '../store/cache';
import { DerivedFlow, flowCounts, stageCounts } from './DerivedFlow';
import { FactoryCardsProvider } from './FactoryCards';
import { GraphSkeleton } from './GraphSkeleton';
import { curatedView } from './lib/curated-view';
import { graphWords } from './lib/graph-view';
import { groupsOf } from './lib/view-groups';
import type { PackBoardGroups } from './lib/board-numbers';
import type { AskRead } from './lib/item-asks';
import { stageLive, type MapLive, type Unread } from './lib/map-live';
import { CuratedMap } from './map/CuratedMap';
import { useMapStructure, usePackGraph } from './map-structure';
import { ReadFailure } from './ReadFailure';
import { SegmentedControl } from './ui/SegmentedControl';
import { DocumentProblems } from './DocumentProblems';

/** The search param that shows the derived map in place of the grouped one. */
const MAP_PARAM = 'map';
const FULL = 'full';

/**
 * Whether the Overview shows the derived map as "Full workflow" (`?map=full`), and the handler a
 * segment calls to choose it or the grouped map.
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
  const graph = usePackGraph(projectId, pack);
  const [full, choose] = useFullWorkflow();
  // Until the graph answers the map's loading shape shows: never one map first and the other
  // after it.
  if (graph.data === undefined)
    return (
      <MapSection>
        {graph.error === undefined ? (
          <GraphSkeleton label="Loading the map" />
        ) : (
          <ReadFailure retry={graph.refetch}>
            The map could not read the pack's graph: {graph.error.message}
          </ReadFailure>
        )}
      </MapSection>
    );
  const words = graphWords(graph.data);
  const boardPath = `/console/p/${encodeURIComponent(projectId)}/board`;
  // The derived map's columns are the same groups the grouped map draws, so a card's heading
  // is its group's on both.
  const groups = groupsOf(graph.data);
  const derived = (
    <DerivedFlow
      flow={flowCounts(
        columnsOf(graph.data, groups, words),
        board?.moving ?? [],
        graph.data.stages,
        asks,
        words.retired
      )}
      graph={graph.data}
      view={words}
      counts={stageCounts(board?.moving ?? [], graph.data.stages, asks, words.retired)}
      live={{ board: boardPath, numbers: board?.numbers, failed: itemsError !== undefined }}
    />
  );
  // A pack whose document declares no groups has nothing to group a map by: the derived map,
  // under its own heading.
  if (groups.length === 0)
    return (
      <div data-pack-map className="flex flex-col gap-2.5">
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
      <DocumentProblems graph={graph.data} />
      {full ? (
        derived
      ) : (
        <Grouped
          projectId={projectId}
          pack={pack}
          graph={graph}
          data={graph.data}
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

/** The grouped map, from the graph its columns, cards and arrows come from. */
function Grouped({
  projectId,
  pack,
  graph,
  data,
  board,
  itemsError,
  boardPath,
  asks,
}: {
  projectId: string;
  pack: string;
  graph: EntityView<PackGraph>;
  /** The graph as read: `graph.data`, once it answered. */
  data: PackGraph;
  board: PackBoardGroups | undefined;
  itemsError: Error | undefined;
  boardPath: string;
  asks: AskRead;
}): ReactElement {
  const view = useMemo(() => curatedView(data), [data]);
  const structure = useMapStructure(graph, view);
  const live: MapLive | Unread = useMemo(() => {
    if (board === undefined) return itemsError === undefined ? 'loading' : 'failed';
    // The Merged card is the Board's Merged column: the items it lists, so the same count.
    return stageLive(
      view,
      board.moving,
      board.merged.recent,
      data.stages,
      asks,
      graphWords(data).retired
    );
  }, [view, board, itemsError, data, asks]);
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
