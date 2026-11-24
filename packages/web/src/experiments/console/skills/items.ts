import type { QueryParams } from '../lib/api-types';
import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

export type ItemWindow = components['schemas']['ItemWindow'];
/** One item read whole, as `GET /api/items` and a window page return it. */
export type ItemRead = components['schemas']['ItemRead'];

/**
 * A page of a project's items with a run started in a window, each read whole. A first page
 * names its window (`since`, `until`); a later one names only the `after` cursor it follows.
 */
export async function listItemWindow(
  opts: QueryParams<'/api/items/window', 'get'>,
  init: { signal?: AbortSignal } = {}
): Promise<ItemWindow> {
  return requestJson('/api/items/window', 'get', { query: opts, signal: init.signal });
}
