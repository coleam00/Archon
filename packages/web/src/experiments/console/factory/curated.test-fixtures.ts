import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackGraph } from '../skills/items';
import type { ViewFile } from './api';
import { curatedView, type CuratedView } from './lib/curated-view';
import { mapArrows, type MapArrow } from './lib/graph-structure';
import { smallGraph } from './__fixtures__/small-pack';
import { smallViewFile } from './__fixtures__/small-view';

/**
 * The Wirasm pack's view file (its How it works explainer), as this repository keeps it until the
 * pack ships it. The How it works drawing tests read it, so CI checks the picture the console
 * shows; they need no graph. Its stage names are checked against the real pack by hand
 * (`check:factory-view`, docs/factory-console/pack-view/README.md).
 */
export const shippedFile = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../../../../docs/factory-console/pack-view/factory-view.json'),
    'utf8'
  )
) as ViewFile;

/** The tests' view file: a small How it works picture drawn over `testGraph`. */
export const testFile: ViewFile = smallViewFile;

/** The tests' pack graph: the Wirasm factory's shape in a few stages, written by hand. */
export const testGraph: PackGraph = smallGraph;

export const testView: CuratedView = curatedView(testFile, testGraph);

export const testArrows: MapArrow[] = mapArrows(testView, testGraph);
