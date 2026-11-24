/**
 * Ending an item, shared by the CLI and the API. The surface resolves who acts, and an end
 * must say who: one with nobody named is refused. The API authorizes the caller as for a
 * ruling (`assertMayRule`): an end changes how every reader sees an item other users' runs
 * are on. The store refuses while a run, a queued start, an ask or a wait on the item is
 * live; a trigger start not yet prepared is checked here, by the item's key.
 */
import {
  ItemEndNotFoundError,
  ItemEndRefusedError,
  ItemEndUnattributedError,
  type ItemEnd,
} from '@archon/workflows/schemas/item-end';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import type { IWorkflowStore } from '@archon/workflows/store';
import { itemAct } from './item-act';
import type { RunActor } from './run-authorization';

type EndStore = Pick<
  IWorkflowStore,
  'getItemRuns' | 'listHeldItemStarts' | 'recordItemEnd' | 'getWorkflowRun'
>;

/**
 * End the item `key` names in project `projectKey`. Throws `ItemEndUnattributedError` when
 * nobody is named, `ItemEndNotFoundError` for a key with no item, and `ItemEndRefusedError`
 * while something on the item is active or waiting.
 */
export async function recordItemEnd(
  store: EndStore,
  target: { projectKey: string; key: string; reason: string },
  actor: RunActor,
  via: RecordSurface
): Promise<ItemEnd> {
  const act = await itemAct(store, actor, via);
  if (act.by === null) throw new ItemEndUnattributedError();
  const found = await store.getItemRuns(target.projectKey, target.key);
  if (found === null) throw new ItemEndNotFoundError(target.projectKey, target.key);
  const itemId = found.item.id;
  // A held start that arrives after this check opens the item again when it is read.
  const [held] = await store.listHeldItemStarts(itemId);
  if (held !== undefined)
    throw new ItemEndRefusedError(target.key, { kind: 'held_start', receiptId: held.receiptId });
  return store.recordItemEnd({ itemId, key: target.key, reason: target.reason, ...act });
}
