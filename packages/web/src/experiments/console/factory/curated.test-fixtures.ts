import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackGraph } from '../skills/items';
import type { ViewFile } from './api';
import { curatedView, type CuratedView } from './lib/curated-view';
import { mapArrows, type MapArrow } from './lib/graph-structure';

/** The Wirasm pack's view file (its How it works explainer), as this repository keeps it until the pack ships it. */
export const shippedFile = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../../../../docs/factory-console/pack-view/factory-view.json'),
    'utf8'
  )
) as ViewFile;

/**
 * The pack graph of the commit that file is written for, af6d0b4a, with the overlay
 * `docs/factory-console/pack-spike/` applied (its words and declarations), as the checker's
 * graph read gives it.
 */
export const shippedGraph = JSON.parse(
  readFileSync(join(import.meta.dir, '__fixtures__', 'pack-graph-af6d0b4a.json'), 'utf8')
) as PackGraph;

export const shippedView: CuratedView = curatedView(shippedFile, shippedGraph);

export const shippedArrows: MapArrow[] = mapArrows(shippedView, shippedGraph);
