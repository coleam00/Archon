import type { PackGraph } from '../skills/items';
import { curatedView, type CuratedView } from './lib/curated-view';
import { mapArrows, type MapArrow } from './lib/graph-structure';
import { smallGraph } from './__fixtures__/small-pack';

/** The tests' pack graph: the Wirasm factory's shape in a few stages, written by hand. */
export const testGraph: PackGraph = smallGraph;

export const testView: CuratedView = curatedView(testGraph);

export const testArrows: MapArrow[] = mapArrows(testView, testGraph);
