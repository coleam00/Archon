/**
 * Refused starts that no run caused: binding starts a fire, a schedule, a webhook or a label
 * made, refused with a stored reason (`refusal`, see `bindingRefusalSchema`). A start a run's
 * end or settled asks caused is not here: its refusal is a stop on that run (`item-stops.ts`).
 */
import {
  bindingRefusalSchema,
  type BindingRefusal,
} from '@archon/workflows/schemas/binding-refusal';
import { getDatabase } from './connection';
import { heldIntent } from './install-hold';
import { launchRunsStep, stepRun } from './item-step';
import { causingRun } from './item-stops';
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
 * caused, unless the same binding has since started a step on the same item key: its
 * prepared launch runs a step (`launchRunsStep`), so a start of an observing workflow under
 * the binding clears nothing. A rejection with no item key (the source could not map one)
 * names nothing to list it on, and one an older binary wrote has no `refusal`; both stay in
 * `archon trigger list` only.
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
      ORDER BY b.updated_at, b.binding_id`
  );
  const steppedSince = await laterStepStarts();
  const starts: StoredRefusedStart[] = [];
  for (const row of rows.rows) {
    if (causingRun(row.source_actor) !== undefined) continue;
    if (steppedSince.has(JSON.stringify([String(row.receipt_id), row.binding_id]))) continue;
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
 * The refused binding starts, as `[receiptId, bindingId]` keys, whose binding has since
 * completed a preparation on the same item key whose launch runs a step.
 */
async function laterStepStarts(): Promise<Set<string>> {
  const later = await getDatabase().query<{
    receipt_id: string;
    binding_id: string;
    launch: unknown;
  }>(
    `SELECT b.receipt_id, b.binding_id, q.launch
       FROM remote_agent_start_receipt_bindings b
       JOIN remote_agent_start_receipts r ON r.id = b.receipt_id
       JOIN remote_agent_start_receipt_bindings l
         ON l.binding_id = b.binding_id AND l.preparation_status = 'complete'
        AND l.updated_at > b.updated_at
       JOIN remote_agent_start_receipts lr ON lr.id = l.receipt_id
        AND COALESCE(l.item_key, lr.item_key) = COALESCE(b.item_key, r.item_key)
       LEFT JOIN remote_agent_resource_start_requests q
         ON q.receipt_id = l.receipt_id AND q.binding_id = l.binding_id
      WHERE b.preparation_status = 'rejected' AND b.refusal IS NOT NULL`
  );
  return new Set(
    later.rows
      .filter(row => launchRunsStep(row.launch ?? null))
      .map(row => JSON.stringify([String(row.receipt_id), row.binding_id]))
  );
}

/**
 * True when a top-level step started on item `itemId` after the start was refused: the item
 * moved on. A run that observes the item (`stepRun`) moves nothing on. Compared with the binding's own timestamp in SQL, so both sides share a format;
 * SQLite records seconds, so a run in the refusal's second leaves it listed.
 */
export async function itemRanSince(
  itemId: string,
  start: Pick<StoredRefusedStart, 'receiptId' | 'bindingId'>
): Promise<boolean> {
  const result = await getDatabase().query(
    `SELECT 1 FROM remote_agent_workflow_runs w
      WHERE w.item_id = $1 AND w.parent_run_id IS NULL AND ${stepRun('w')}
        AND w.started_at > (SELECT b.updated_at FROM remote_agent_start_receipt_bindings b
                             WHERE b.receipt_id = $2 AND b.binding_id = $3)
      LIMIT 1`,
    [itemId, start.receiptId, start.bindingId]
  );
  return result.rows.length > 0;
}
