/**
 * A binding preparation that failed: the binding is marked `failed` (to be prepared again)
 * or `rejected` (terminal). A rejection with a `refusal` is also recorded on the stop of the
 * run whose end or settled asks caused the start (`recordRefusedStartStop`), in the same
 * transaction, so that run, the item read and attention show the refused start.
 */
import { storedBindingRefusal } from '@archon/workflows/schemas/binding-refusal';
import type { IResourceStartStore } from '@archon/workflows/resource-start-store';
import type { FileSettingRefusal } from '@archon/workflows/schemas/pack-settings';
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
  return getDatabase().withTransaction(query => rejectPreparation(query, { ...input, refusal }));
}

/**
 * Reject a binding this owner prepares and record its refusal as a stop on the run that
 * caused it, inside the caller's transaction: the one way a refusal is written, for a
 * failed preparation and for a queued start its trigger file no longer starts.
 */
export async function rejectPreparation(
  query: Query,
  input: FailedPreparation & { refusal: NonNullable<FailedPreparation['refusal']> }
): Promise<boolean> {
  const { refusal } = input;
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
      ...fileSettingDetail(input),
    },
  });
  return true;
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
      !input.retryable && input.refusal !== undefined
        ? storedBindingRefusal(input.refusal, fileSettingDetail(input))
        : null,
    ]
  );
  return result.rowCount === 1;
}

/** The setting a `file_setting_missing` refusal names, on the binding row and the stop alike. */
function fileSettingDetail({ fileSetting }: FailedPreparation): {
  fileSetting?: FileSettingRefusal;
} {
  return fileSetting === undefined ? {} : { fileSetting };
}
