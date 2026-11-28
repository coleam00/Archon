import { useMemo } from 'react';
import { getPackGraph, type PackGraph } from '../skills/items';
import { useEntity, type EntityView } from '../store/cache';
import { K } from '../store/keys';
import type { CuratedView } from './lib/curated-view';
import { mapArrows, type MapArrow } from './lib/graph-structure';

/** The pack graph read, and the map's arrows once it is read. */
export interface MapStructure {
  graph: EntityView<PackGraph>;
  /** Undefined until the graph is read. */
  arrows: MapArrow[] | undefined;
}

/**
 * The pack graph (`GET /api/packs/{pack}/graph`) under the one key the Overview and the Board
 * read it with (`K.packGraph`), so a page reads it once, and the map's arrows projected from it.
 */
export function usePackGraph(projectId: string, pack: string): EntityView<PackGraph> {
  return useEntity(K.packGraph(projectId, pack), () => getPackGraph(projectId, pack));
}

export function useMapStructure(
  graph: EntityView<PackGraph>,
  view: CuratedView | undefined
): MapStructure {
  const arrows = useMemo(
    () =>
      graph.data === undefined || view === undefined ? undefined : mapArrows(view, graph.data),
    [graph.data, view]
  );
  return { graph, arrows };
}
