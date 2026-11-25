/**
 * Refused starts that no run caused: binding starts a fire, a schedule, a webhook or a label
 * made, refused with a stored reason (`refusal`, see `bindingRefusalSchema`). A start a run's
 * end or settled asks caused is not here while that run exists: its refusal is a stop on
 * that run (`item-stops.ts`). Once the run is deleted the stop has nowhere to show, so the
 * refusal is listed here instead.
 */
import {
  ASKS_SETTLED_SOURCE_ACTOR,
  RUN_ENDED_SOURCE_ACTOR,
  sourceReceiptInputSchema,
} from '@archon/workflows/schemas/resource-start';
import {
  bindingRefusalSchema,
  type BindingRefusal,
} from '@archon/workflows/schemas/binding-refusal';
import { getDatabase } from './connection';
import { heldIntent } from './install-hold';
import { parseStoredJson } from './resource-starts';
import { toHydratedTimestamp } from './timestamps';
import { getLog } from './workflow-run-shared';

/** A refused start no run caused, as stored; `store-adapter` places it in its project. */
export interface StoredRefusedStart {
  receiptId: string;
  bindingId: string;
  hostId: string | null;
  workflow: string | null;
  cwd: string | null;
  itemKey: string;
  refusal: BindingRefusal;
  refusedAt: string;
}

/**
 * The rejected binding starts on an item that recorded why (`refusal`) and that no run
 * caused, unless the same binding has since started on the same item key. A rejection
 * with no item key (the source could not map one) names nothing to list it on, and one an
 * older binary wrote has no `refusal`; both stay in `archon trigger list` only.
 */
export async function listStoredRefusedStarts(): Promise<StoredRefusedStart[]> {
  const rows = await getDatabase().query<{
    receipt_id: string;
    binding_id: string;
    host_id: string | null;
    intent: unknown;
    item_key: string;
    refusal: unknown;
    source_actor: unknown;
    updated_at: string | Date;
  }>(
    `SELECT b.receipt_id, b.binding_id, b.host_id, b.intent, b.refusal, b.updated_at,
            COALESCE(b.item_key, r.item_key) AS item_key, r.source_actor
       FROM remote_agent_start_receipt_bindings b
       JOIN remote_agent_start_receipts r ON r.id = b.receipt_id
      WHERE b.preparation_status = 'rejected' AND b.refusal IS NOT NULL
        AND COALESCE(b.item_key, r.item_key) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM remote_agent_start_receipt_bindings l
            JOIN remote_agent_start_receipts lr ON lr.id = l.receipt_id
           WHERE l.binding_id = b.binding_id AND l.preparation_status = 'complete'
             AND COALESCE(l.item_key, lr.item_key) = COALESCE(b.item_key, r.item_key)
             AND l.updated_at > b.updated_at)
      ORDER BY b.updated_at, b.binding_id`
  );
  const starts: StoredRefusedStart[] = [];
  for (const row of rows.rows) {
    if (await causingRunExists(row.source_actor)) continue;
    const refusal = bindingRefusalSchema.safeParse(parseStoredJson(row.refusal));
    if (!refusal.success) {
      getLog().warn(
        { receiptId: row.receipt_id, bindingId: row.binding_id },
        'refused_start.refusal_unreadable'
      );
      continue;
    }
    const intent = heldIntent(row.intent);
    starts.push({
      receiptId: String(row.receipt_id),
      bindingId: row.binding_id,
      hostId: row.host_id,
      workflow: intent?.workflow ?? null,
      cwd: intent?.cwd ?? null,
      itemKey: row.item_key,
      refusal: refusal.data,
      refusedAt: toHydratedTimestamp(row.updated_at).toISOString(),
    });
  }
  return starts;
}

/**
 * True when a run's end or settled asks caused the receipt and that run still exists: its
 * stop shows the refusal.
 */
async function causingRunExists(stored: unknown): Promise<boolean> {
  const actor = sourceReceiptInputSchema.shape.sourceActor.safeParse(
    parseStoredJson(stored ?? null)
  );
  const cause = actor.success ? actor.data : null;
  if (cause?.source !== RUN_ENDED_SOURCE_ACTOR && cause?.source !== ASKS_SETTLED_SOURCE_ACTOR)
    return false;
  const run = await getDatabase().query('SELECT 1 FROM remote_agent_workflow_runs WHERE id = $1', [
    cause.id,
  ]);
  return run.rows.length > 0;
}

/**
 * True when a top-level run started on item `itemId` after the start was refused: the item
 * moved on. Compared with the binding's own timestamp in SQL, so both sides share a format;
 * SQLite records seconds, so a run in the refusal's second leaves it listed.
 */
export async function itemRanSince(
  itemId: string,
  start: Pick<StoredRefusedStart, 'receiptId' | 'bindingId'>
): Promise<boolean> {
  const result = await getDatabase().query(
    `SELECT 1 FROM remote_agent_workflow_runs w
      WHERE w.item_id = $1 AND w.parent_run_id IS NULL
        AND w.started_at > (SELECT b.updated_at FROM remote_agent_start_receipt_bindings b
                             WHERE b.receipt_id = $2 AND b.binding_id = $3)
      LIMIT 1`,
    [itemId, start.receiptId, start.bindingId]
  );
  return result.rows.length > 0;
}
