import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

/** An item as the engine reads it; `standing` says where it is and whether it is open. */
export type ItemRead = components['schemas']['ItemRead'];
export type PackGraph = components['schemas']['PackGraph'];

/** A page of items and the cursor of the next one, null on the last. */
export type ItemPage = Pick<components['schemas']['ItemWindow'], 'items' | 'next'>;

// The read lists the items with a run started in a window; this one holds every item.
const EVERY_ITEM = '1970-01-01';

/** One page of a project's items that are open (`open`) or at rest. */
export async function listItemsPage(
  projectId: string,
  open: boolean,
  after?: string
): Promise<ItemPage> {
  return requestJson('/api/items/window', 'get', {
    query: {
      project: projectId,
      open: open ? 'true' : 'false',
      limit: 100,
      ...(after === undefined ? { since: EVERY_ITEM } : { after }),
    },
  });
}

/** Every open item of a project. */
export async function listOpenItems(projectId: string): Promise<ItemRead[]> {
  const items: ItemRead[] = [];
  let page = await listItemsPage(projectId, true);
  for (;;) {
    items.push(...page.items);
    if (page.next === null) return items;
    page = await listItemsPage(projectId, true, page.next);
  }
}

/** A pack's stages, in the order work flows through them, as the project has it installed. */
export async function getPackGraph(projectId: string, pack: string): Promise<PackGraph> {
  return requestJson('/api/packs/{pack}/graph', 'get', {
    params: { pack },
    query: { codebaseId: projectId },
  });
}
