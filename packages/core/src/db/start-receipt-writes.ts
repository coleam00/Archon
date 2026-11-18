import { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
import type {
  ResourceStartBindingIntent,
  SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import { getDatabase } from './connection';
import { resolveWakes } from './item-waits';
import type { TransactionQuery as Query } from './resource-slots';

/**
 * Record a receipt. A binding that wakes a wait is resolved against the open waits in the
 * same transaction (`resolveWakes`), with its launch's project from `projectKeyOf`, read
 * first; a delivery already recorded is left to `insertStartReceipt`, which answers replay
 * or conflict and resolves nothing.
 */
export async function acceptStartReceipt(
  input: SourceReceiptAcceptance,
  projectKeyOf: (cwd: string) => Promise<string | null> = async () => null
): Promise<{ receiptId: string; replay: boolean }> {
  const projectKeys = new Map<string, string | null>();
  for (const binding of input.bindings)
    if (binding.wake !== undefined)
      projectKeys.set(binding.bindingId, await projectKeyOf(binding.launch.cwd));
  return getDatabase().withTransaction(async query => {
    if (projectKeys.size === 0) return insertStartReceipt(query, input);
    const { deliveryId, sourceInstanceId } = input.receipt;
    const recorded =
      deliveryId !== null &&
      (
        await query(
          'SELECT 1 FROM remote_agent_start_receipts WHERE source_instance_id = $1 AND delivery_id = $2',
          [sourceInstanceId, deliveryId]
        )
      ).rows.length > 0;
    return insertStartReceipt(
      query,
      recorded ? input : await resolveWakes(query, input, projectKeys)
    );
  });
}

/**
 * Accept one receipt inside the caller's transaction: the one body behind
 * `acceptStartReceipt` and the run completion that causes starts, so the two cannot
 * write a receipt differently. A delivery already recorded is a replay, or a conflict
 * when its content differs.
 */
export async function insertStartReceipt(
  query: Query,
  input: SourceReceiptAcceptance
): Promise<{ receiptId: string; replay: boolean }> {
  const inserted = await query(
    `INSERT INTO remote_agent_start_receipts
     (id, source_instance_id, delivery_id, content_digest, received_at, occurred_at, source_actor, outcome, reason, item_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING`,
    [
      input.receipt.id,
      input.receipt.sourceInstanceId,
      input.receipt.deliveryId,
      input.receipt.contentDigest,
      input.receipt.receivedAt,
      input.receipt.occurredAt,
      JSON.stringify(input.receipt.sourceActor),
      input.outcome,
      input.reason ?? null,
      input.receipt.itemKey ?? null,
    ]
  );
  if (inserted.rowCount === 0) {
    if (input.receipt.deliveryId === null) {
      throw new Error(`Source receipt id '${input.receipt.id}' already exists`);
    }
    const found = await query<{ id: string; content_digest: string }>(
      'SELECT id, content_digest FROM remote_agent_start_receipts WHERE source_instance_id = $1 AND delivery_id = $2',
      [input.receipt.sourceInstanceId, input.receipt.deliveryId]
    );
    const prior = found.rows[0];
    if (!prior) throw new Error(`Source receipt id '${input.receipt.id}' already exists`);
    if (prior.content_digest !== input.receipt.contentDigest)
      throw new SourceReceiptDigestConflictError(
        'Delivery identity was reused with different verified content'
      );
    return { receiptId: prior.id, replay: true };
  }
  for (const binding of input.bindings) {
    await query(
      `INSERT INTO remote_agent_start_receipt_bindings
       (receipt_id,binding_id,binding_revision,host_id,intent,event_input_names,checkout_from,item_key,preparation_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
      [
        input.receipt.id,
        binding.bindingId,
        binding.bindingRevision,
        binding.hostId,
        ...storableIntent(binding),
        binding.itemKey ?? null,
      ]
    );
  }
  for (const evaluated of input.evaluatedBindings ?? []) {
    await query(
      `INSERT INTO remote_agent_start_receipt_bindings
       (receipt_id,binding_id,binding_revision,host_id,intent,preparation_status,preparation_error)
       VALUES ($1,$2,$3,NULL,NULL,$4,$5)`,
      [
        input.receipt.id,
        evaluated.bindingId,
        evaluated.bindingRevision,
        evaluated.status,
        evaluated.reason,
      ]
    );
  }
  return { receiptId: input.receipt.id, replay: false };
}

/**
 * Older binaries parse the `intent` column strictly, so it keeps their shape. Event
 * inputs are merged into `launch.inputs` (an older binary passes them through, as it
 * always did) and their names go to `event_input_names`. A checkout hand-off goes to
 * `checkout_from`; `launch.isolation` already names its branch, so an older binary starts
 * the stage on that branch without the commit pin or a read-only copy. The binding's item
 * key goes to its own `item_key` column. `readStoredIntent` reverses it.
 */
function storableIntent(
  binding: ResourceStartBindingIntent
): [string, string | null, string | null] {
  // A wake is resolved before a binding is written (`resolveWakes`); none is ever stored.
  const { eventInputs, checkoutFrom, itemKey: _itemKey, wake: _wake, ...intent } = binding;
  const handoff = checkoutFrom ? JSON.stringify(checkoutFrom) : null;
  if (!eventInputs || Object.keys(eventInputs).length === 0)
    return [JSON.stringify(intent), null, handoff];
  return [
    JSON.stringify({
      ...intent,
      launch: { ...intent.launch, inputs: { ...intent.launch.inputs, ...eventInputs } },
    }),
    JSON.stringify(Object.keys(eventInputs)),
    handoff,
  ];
}
