/**
 * A binding preparation that failed: the binding is marked `failed` (to be prepared again)
 * or `rejected` (terminal). A rejection with a `refusal` is also recorded on the stop of the
 * run whose end or settled asks caused the start (`recordRefusedStartStop`), in the same
 * transaction, so that run, the item read and attention show the refused start.
 */
import { storedBindingRefusal } from '@archon/workflows/schemas/binding-refusal';
import type { IResourceStartStore } from '@archon/workflows/resource-start-store';
import { resourceStartBindingIntentSchema } from '@archon/workflows/schemas/resource-start';
import { getDatabase, getDialect } from './connection';
import { recordRefusedStartStop } from './item-stops';
import type { TransactionQuery as Query } from './resource-slots';
import { getLog } from './workflow-run-shared';

type FailedPreparation = Parameters<IResourceStartStore['failStartBindingPreparation']>[0];

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
      await query<{ intent: unknown }>(
        'SELECT intent FROM remote_agent_start_receipt_bindings WHERE receipt_id = $1 AND binding_id = $2',
        [input.receiptId, input.bindingId]
      )
    ).rows[0];
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
    await recordRefusedStartStop(query, receiptId, {
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
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = $4, preparation_error = $5, forge_refusal = $6, refusal = $7, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3`,
    [
      input.receiptId,
      input.bindingId,
      input.ownerId,
      input.retryable ? 'failed' : 'rejected',
      input.error,
      input.forgeRefusal ? JSON.stringify(input.forgeRefusal) : null,
      !input.retryable && input.refusal !== undefined ? storedBindingRefusal(input.refusal) : null,
    ]
  );
  return result.rowCount === 1;
}
