import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

/** An item as the engine reads it; `standing` says where it is and whether it is open. */
export type ItemRead = components['schemas']['ItemRead'];
export type PackGraph = components['schemas']['PackGraph'];

export type ItemState = ItemRead['standing']['state'];

// Every standing state, for a read that keeps them all; a new state fails the build.
export const ITEM_STATES = Object.keys({
  running: true,
  waiting: true,
  queued: true,
  failed: true,
  stopped: true,
  done: true,
  resting: true,
} satisfies Record<ItemState, true>) as ItemState[];

/** A page of items, the cursor of the next one (null on the last), and the window's totals. */
export type ItemPage = Pick<components['schemas']['ItemWindow'], 'items' | 'next' | 'totals'>;

// The read lists the items with a run started in a window; this one holds every item that has
// a run. An item with no run is in no window: a work order shows its runless members itself.
const EVERY_ITEM = '1970-01-01';

/**
 * One page of a project's items standing in one of `states`, most recently active first;
 * `pack` keeps the items standing at a run of that pack, and `since` the items with a run
 * started at or after that time.
 */
export async function listItemsPage(
  projectId: string,
  states: readonly ItemState[],
  page: { after?: string; pack?: string; limit?: number; since?: string } = {}
): Promise<ItemPage> {
  return requestJson('/api/items/window', 'get', {
    query: {
      project: projectId,
      states: states.join(','),
      limit: page.limit ?? 100,
      ...(page.pack === undefined ? {} : { pack: page.pack }),
      ...(page.after === undefined ? { since: page.since ?? EVERY_ITEM } : { after: page.after }),
    },
  });
}

/** Every item of a project that has a run, standing in one of `states`. */
export async function listItems(
  projectId: string,
  states: readonly ItemState[]
): Promise<ItemRead[]> {
  const items: ItemRead[] = [];
  let page = await listItemsPage(projectId, states);
  for (;;) {
    items.push(...page.items);
    if (page.next === null) return items;
    page = await listItemsPage(projectId, states, { after: page.next });
  }
}

/** One item of a project, read whole, whether or not it has a run. */
export async function getItem(projectId: string, key: string): Promise<ItemRead> {
  return requestJson('/api/items', 'get', { query: { project: projectId, key } });
}

/** A pack's stages, in the order work flows through them, as the project has it installed. */
export async function getPackGraph(projectId: string, pack: string): Promise<PackGraph> {
  return requestJson('/api/packs/{pack}/graph', 'get', {
    params: { pack },
    query: { codebaseId: projectId },
  });
}

export type Observing = components['schemas']['Observing'];

/** What the install reads for event bindings without webhooks, and the watcher's last pass. */
export async function getObserving(): Promise<Observing> {
  return requestJson('/api/observing', 'get');
}
