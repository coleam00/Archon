import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackGraph } from '../skills/items';
import type { FactoryView } from './api';
import { curatedView, type CuratedView } from './lib/curated-view';
import { mapArrows, type MapArrow } from './lib/graph-structure';

/** The Wirasm pack's curated view file, as this repository keeps it until the pack ships it. */
export const shippedFile = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../../../../docs/factory-console/pack-view/factory-view.json'),
    'utf8'
  )
) as FactoryView;

/** The pack graph of the commit that file is written for, c1104737, as the checker's graph read gives it. */
export const shippedGraph = JSON.parse(
  readFileSync(join(import.meta.dir, '__fixtures__', 'pack-graph-c1104737.json'), 'utf8')
) as PackGraph;

export const shippedView: CuratedView = curatedView(shippedFile, shippedGraph);

export const shippedArrows: MapArrow[] = mapArrows(shippedView, shippedGraph);
