import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryItemDetail } from '../skills/factory';
import type { FactoryViewListed } from './lib/views';

/**
 * Real `GET /api/factory/item` responses (see each file's `note`): item 1 (one deliver run,
 * two rounds), item 2 (three rounds), item 3 (two deliver runs, each ending in an ask, with
 * the answers), item 6 (a deliver run running its build step). Captured with each run's story
 * facts (its step starts, models, change and words): item 111 (one deliver run, two rounds,
 * merged by hand), 86 (parked by triage), 113 (a build that asked, answered "send back"), 115
 * (a build that asked, answered "replan"), 125 (the three-stage delivery: four check rounds,
 * asks on the way, a CI send-back, merged by the factory).
 */
export function itemDetail(
  key: '1' | '2' | '3' | '6' | '111' | '86' | '113' | '115' | '125'
): FactoryItemDetail {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dir, '__fixtures__', `item-${key}.json`), 'utf8')
  ) as { response: FactoryItemDetail };
  return raw.response;
}

/** The declaration this repository ships for the pack the fixtures' runs come from. */
export const shippedView: FactoryViewListed['declaration'] = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      '../../../../../../.archon/packs/Wirasm.archon-software-factory.factory-view.json'
    ),
    'utf8'
  )
) as FactoryViewListed['declaration'];

/**
 * The shipped declaration as `GET /api/factory/views` lists it: its pack key, and each
 * workflow's run name as runs record it and the pack graph's stages carry it.
 */
export const shippedListed: FactoryViewListed = {
  pack: shippedView.pack,
  packKey: 'Wirasm.archon-software-factory',
  runNames: Object.fromEntries(
    shippedView.stages.flatMap(stage =>
      stage.workflows.map(workflow => [workflow, `${shippedView.pack}:${workflow}`])
    )
  ),
  source: 'project-file',
  path: '/repo/.archon/packs/Wirasm.archon-software-factory.factory-view.json',
  declaration: shippedView,
};

/** The project the fixtures' links name. */
export const PROJECT = 'c9a89726701fe4be95346226c359a961';
