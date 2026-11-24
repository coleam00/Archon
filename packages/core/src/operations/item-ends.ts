/**
 * Ending an item, shared by the CLI and the API. The surface resolves who acts; this
 * refuses while anything on the item is active or waiting, naming it, and writes the end.
 * The API authorizes the caller as for a ruling (`assertMayRule`): an end changes how every
 * reader sees an item other users' runs are on.
 */
import { askItemRef } from '@archon/workflows/attention-item-refs';
import { readItemRuns } from '@archon/workflows/item-read';
import {
  ItemEndNotFoundError,
  ItemEndRefusedError,
  type ItemEnd,
  type ItemEndBlocker,
} from '@archon/workflows/schemas/item-end';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/run-status';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import type { IWorkflowStore } from '@archon/workflows/store';
import { itemAct } from './item-act';
import type { RunActor } from './run-authorization';

type EndStore = Pick<
  IWorkflowStore,
  | 'getItemRuns'
  | 'listQueuedItemStarts'
  | 'listHeldItemStarts'
  | 'listItemAsks'
  | 'listOpenItemWaits'
  | 'recordItemEnd'
  | 'getWorkflowRun'
>;

/** The first thing on the item that is still active or waiting, or null when nothing is. */
async function endBlocker(
  store: EndStore,
  itemId: string,
  found: NonNullable<Awaited<ReturnType<typeof readItemRuns>>>
): Promise<ItemEndBlocker | null> {
  const active = found.runs.find(run => !TERMINAL_WORKFLOW_STATUSES.includes(run.status));
  if (active !== undefined) return { kind: 'run', runId: active.id, status: active.status };
  const [unreadable] = found.degraded;
  if (unreadable !== undefined) return { kind: 'run', runId: unreadable.runId, status: null };
  const [queued] = await store.listQueuedItemStarts(itemId);
  if (queued !== undefined) return { kind: 'queued_start', requestId: queued.requestId };
  const [held] = await store.listHeldItemStarts(itemId);
  if (held !== undefined) return { kind: 'held_start', receiptId: held.receiptId };
  const ask = (await store.listItemAsks(itemId)).find(
    (read): read is StoredItemAsk => !('type' in read) && read.closed === null
  );
  if (ask !== undefined) return { kind: 'open_ask', ref: askItemRef(ask.id) };
  const [wait] = await store.listOpenItemWaits(itemId);
  if (wait !== undefined) return { kind: 'open_wait', runId: wait.runId };
  return null;
}

/**
 * End the item `key` names in project `projectKey`. Throws `ItemEndNotFoundError` for a key
 * with no item and `ItemEndRefusedError` while something on it is active. A start that
 * slips in after the check makes a newer run, which voids the end when it reads.
 */
export async function recordItemEnd(
  store: EndStore,
  target: { projectKey: string; key: string; reason: string },
  actor: RunActor,
  via: RecordSurface
): Promise<ItemEnd> {
  const act = await itemAct(store, actor, via);
  const found = await readItemRuns(store, target.projectKey, target.key);
  if (found === null) throw new ItemEndNotFoundError(target.projectKey, target.key);
  const blocker = await endBlocker(store, found.item.id, found);
  if (blocker !== null) throw new ItemEndRefusedError(target.key, blocker);
  return store.recordItemEnd({ itemId: found.item.id, reason: target.reason, ...act });
}
