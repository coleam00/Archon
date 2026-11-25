/**
 * A binding preparation that failed: the binding is marked `failed` (to be prepared again)
 * or `rejected` (terminal). A rejection with a `refusal` also stops the item on the run
 * whose end or settled asks caused the start (`recordRefusedStartStop`), in the same
 * transaction, so the item read and attention show the refused start where its stage ended.
 */
import {
  resourceStartBindingIntentSchema,
  type ForgeRefusal,
} from '@archon/workflows/schemas/resource-start';
import type { StartRefusalReason } from '@archon/workflows/schemas/run-metadata';
import { getDatabase, getDialect } from './connection';
import { recordRefusedStartStop } from './item-stops';
import type { TransactionQuery as Query } from './resource-slots';
import { getLog } from './workflow-run-shared';

interface FailedPreparation {
  receiptId: string;
  bindingId: string;
  ownerId: string;
  retryable: boolean;
  error: string;
  forgeRefusal?: ForgeRefusal;
  refusal?: StartRefusalReason;
}

/** See `IResourceStartStore.failStartBindingPreparation`. */
export async function failStartBindingPreparation(input: FailedPreparation): Promise<boolean> {
  const { refusal } = input;
  if (input.retryable || refusal === undefined) {
    const db = getDatabase();
    return markFailed((sql, params) => db.query(sql, params), input);
  }
  return getDatabase().withTransaction(async query => {
    if (!(await markFailed(query, input))) return false;
    const row = (
      await query<{ intent: unknown; item_key: string | null; receipt_item_key: string | null }>(
        `SELECT b.intent, b.item_key, r.item_key AS receipt_item_key
           FROM remote_agent_start_receipt_bindings b
           JOIN remote_agent_start_receipts r ON r.id = b.receipt_id
          WHERE b.receipt_id = $1 AND b.binding_id = $2`,
        [input.receiptId, input.bindingId]
      )
    ).rows[0];
    // The binding's own item, else its receipt's, as admission names it.
    const itemKey = row?.item_key ?? row?.receipt_item_key;
    if (!itemKey) return true;
    const intent = resourceStartBindingIntentSchema.safeParse(
      typeof row?.intent === 'string' ? JSON.parse(row.intent) : row?.intent
    );
    if (!intent.success) {
      // The rejection stands; only the stop that would show it on the item is lost.
      getLog().error(
        { receiptId: input.receiptId, bindingId: input.bindingId },
        'resource_start.refusal_stop_unreadable_intent'
      );
      return true;
    }
    const { receiptId, bindingId } = input;
    const workflow = intent.data.launch.workflowName;
    await recordRefusedStartStop(query, receiptId, itemKey, {
      refused: {
        receiptId,
        bindingId,
        workflow,
        reason: refusal,
        refusedAt: new Date().toISOString(),
      },
    });
    return true;
  });
}

async function markFailed(query: Query, input: FailedPreparation): Promise<boolean> {
  const result = await query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = $4, preparation_error = $5, forge_refusal = $6, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3`,
    [
      input.receiptId,
      input.bindingId,
      input.ownerId,
      input.retryable ? 'failed' : 'rejected',
      input.error,
      input.forgeRefusal ? JSON.stringify(input.forgeRefusal) : null,
    ]
  );
  return result.rowCount === 1;
}
