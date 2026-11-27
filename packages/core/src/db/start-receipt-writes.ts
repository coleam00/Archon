import { storedBindingRefusal } from '@archon/workflows/schemas/binding-refusal';
import { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
import type {
  ResourceStartBindingIntent,
  SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import { getDatabase } from './connection';
import { giveItemPriority } from './item-priorities';
import { openWaitingRuns, resolveWakes, type PreparedWake, type WakeMapping } from './item-waits';
import { ensureItemInProject } from './items';
import type { TransactionQuery as Query } from './resource-slots';

/**
 * Record a receipt. A binding that wakes a wait is resolved against the open waits in the
 * same transaction (`resolveWakes`), with its launch's project from `projectKeyOf`, and,
 * for one that carries `{ input }` reads, the problems `wakes.inputProblems` finds for each
 * run it could wake, both read first.
 * The resolution runs only after this transaction has claimed the delivery by writing the
 * receipt's row: a concurrent delivery with the same identity waits on that row and then
 * replays, so it can never close a wait (one opened since, say) for a receipt that is not
 * recorded.
 */
export async function acceptStartReceipt(
  input: SourceReceiptAcceptance,
  projectKeyOf: (cwd: string) => Promise<string | null> = async () => null,
  /** What a wake binding carries from the waiting run; see `WakeMapping`. */
  wakes?: WakeMapping
): Promise<{ receiptId: string; replay: boolean }> {
  const prepared = new Map<string, PreparedWake>();
  for (const binding of input.bindings) {
    const { wake } = binding;
    if (wake === undefined) continue;
    const inputProblems = new Map<string, readonly string[]>();
    // Definitions are read only for a wake that carries an `{ input }` read, and only of the
    // runs it could meet: one that maps event fields or answers alone reads nothing more.
    const readsRunInputs = Object.values(wake.inputs ?? {}).some(source => 'input' in source);
    if (readsRunInputs && wakes !== undefined)
      for (const waiting of await openWaitingRuns(wake))
        inputProblems.set(waiting.runId, await wakes.inputProblems({ ...binding, wake }, waiting));
    prepared.set(binding.bindingId, {
      projectKey: await projectKeyOf(binding.launch.cwd),
      inputProblems,
    });
  }
  const priority = await priorityTargets(input, projectKeyOf);
  return getDatabase().withTransaction(async query => {
    const accepted = await insertStartReceipt(
      query,
      input,
      prepared.size === 0
        ? undefined
        : claimed => resolveWakes(query, claimed, prepared, wakes?.start)
    );
    // Only the acceptance that claims the delivery gives priority; a replay changes nothing.
    if (!accepted.replay)
      for (const target of priority)
        await giveItemPriority(
          query,
          await ensureItemInProject(query, target.projectKey, target.key)
        );
    return accepted;
  });
}

/**
 * The items a receipt asking for priority (`trigger fire --priority`) gives it to: its item
 * in each of its starts' projects. Priority is a fact on the item, written once here, so no
 * start carries it to apply later. Every project must already be registered.
 */
async function priorityTargets(
  input: SourceReceiptAcceptance,
  projectKeyOf: (cwd: string) => Promise<string | null>
): Promise<{ projectKey: string; key: string }[]> {
  const key = input.receipt.itemKey;
  if (!input.receipt.priority) return [];
  if (key === undefined) throw new Error('A receipt that asks for priority must name its item.');
  const projects = new Set<string>();
  for (const binding of input.bindings) {
    const projectKey = await projectKeyOf(binding.launch.cwd);
    if (projectKey === null)
      throw new Error(
        `Cannot give item '${key}' priority: '${binding.launch.cwd}' is not a registered project.`
      );
    projects.add(projectKey);
  }
  return [...projects].map(projectKey => ({ projectKey, key }));
}

/**
 * Accept one receipt inside the caller's transaction: the one body behind
 * `acceptStartReceipt` and the run completion that causes starts, so the two cannot
 * write a receipt differently. A delivery already recorded is a replay, or a conflict
 * when its content differs. `resolve`, when given, runs only once this write has claimed
 * the delivery and decides the bindings and outcome actually recorded.
 */
export async function insertStartReceipt(
  query: Query,
  input: SourceReceiptAcceptance,
  resolve?: (claimed: SourceReceiptAcceptance) => Promise<SourceReceiptAcceptance>
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
  const recorded = resolve === undefined ? input : await resolve(input);
  if (recorded.outcome !== input.outcome || recorded.reason !== input.reason)
    await query('UPDATE remote_agent_start_receipts SET outcome = $2, reason = $3 WHERE id = $1', [
      input.receipt.id,
      recorded.outcome,
      recorded.reason ?? null,
    ]);
  await insertReceiptBindings(query, recorded);
  return { receiptId: recorded.receipt.id, replay: false };
}

/** The rows of a claimed receipt's bindings: one per start, one per binding that starts nothing. */
async function insertReceiptBindings(
  query: Query,
  recorded: SourceReceiptAcceptance
): Promise<void> {
  for (const binding of recorded.bindings) {
    await query(
      `INSERT INTO remote_agent_start_receipt_bindings
       (receipt_id,binding_id,binding_revision,host_id,intent,event_input_names,checkout_from,item_key,start_limit,grants_limit,start_overrides,preparation_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')`,
      [
        recorded.receipt.id,
        binding.bindingId,
        binding.bindingRevision,
        binding.hostId,
        ...storableIntent(binding),
        binding.itemKey ?? null,
        binding.limit ? JSON.stringify(binding.limit) : null,
        binding.grants ?? null,
        binding.startOverrides ? JSON.stringify(binding.startOverrides) : null,
      ]
    );
  }
  for (const evaluated of recorded.evaluatedBindings ?? []) {
    await query(
      `INSERT INTO remote_agent_start_receipt_bindings
       (receipt_id,binding_id,binding_revision,host_id,intent,preparation_status,preparation_error,refusal,item_key)
       VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6,$7)`,
      [
        recorded.receipt.id,
        evaluated.bindingId,
        evaluated.bindingRevision,
        evaluated.status,
        evaluated.reason,
        // An unmatched binding was not refused; a rejection is the hand-off's or the source's.
        evaluated.status !== 'rejected'
          ? null
          : storedBindingRefusal(evaluated.refused?.reason ?? 'rejected_by_source'),
        evaluated.itemKey ?? null,
      ]
    );
  }
}

/**
 * Older binaries parse the `intent` column strictly, so it keeps their shape. Event
 * inputs are merged into `launch.inputs` (an older binary passes them through, as it
 * always did) and their names go to `event_input_names`. A checkout hand-off goes to
 * `checkout_from`; `launch.isolation` already names its branch, so an older binary starts
 * the stage on that branch without the commit pin or a read-only copy. The binding's item
 * key goes to its own `item_key` column, and a start limit and the limit it grants to
 * `start_limit` and `grants_limit`; an older binary admits such a start without counting
 * it. A fire's `startOverrides` go to `start_overrides`, so an older binary runs the start
 * on the config it would have chosen; `readStoredIntent` reverses them.
 */
export function storableIntent(
  binding: ResourceStartBindingIntent
): [string, string | null, string | null] {
  // A wake is resolved before a binding is written (`resolveWakes`); none is ever stored.
  const {
    eventInputs,
    checkoutFrom,
    itemKey: _itemKey,
    wake: _wake,
    limit: _limit,
    grants: _grants,
    startOverrides: _startOverrides,
    ...intent
  } = binding;
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
