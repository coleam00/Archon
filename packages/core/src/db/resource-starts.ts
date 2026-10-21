import { lockCheckoutOwnership } from './checkout-ownership';
import { z } from 'zod';
import {
  SourceReceiptDigestConflictError,
  drainableStarts,
  resourceStartBlocker,
  validateStartReceiptLimit,
} from '@archon/workflows/resource-start-store';
import type {
  StartBindingInspection,
  StartReceiptInspection,
  ResourceStartRequestInspection,
  QueuedResourceStartInspection,
} from '@archon/workflows/resource-start-store';
export { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
export type {
  StartBindingInspection,
  StartReceiptInspection,
  ResourceStartRequestInspection,
} from '@archon/workflows/resource-start-store';
import type {
  PreparedWorkflowLaunch,
  ResourceStartBindingIntent,
  ResourceStartDisposition,
  ResourceStartIntent,
  SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import {
  sourceReceiptInputSchema,
  preparedWorkflowLaunchSchema,
  resourceStartBindingIntentSchema,
} from '@archon/workflows/schemas/resource-start';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDialect } from './connection';
import {
  addResourceSlotHolder,
  lockResourceSlot,
  resourceStartOccupancy,
  parseQueuedResourceStart,
  type TransactionQuery as Query,
} from './resource-slots';
import { insertWorkflowRun } from './workflows';

interface RequestRow {
  id: string;
  resource_key: string;
  host_id: string;
  overlap_policy: ResourceStartRequestInspection['overlap'];
  status: ResourceStartRequestInspection['status'];
  blocker_run_id: string | null;
  blocker_kind: NonNullable<ResourceStartRequestInspection['blocker']>['kind'] | null;
  launch: unknown;
}

/** Start requests are the run holder's durable FIFO waiters for a resource slot. */
async function admitExisting(
  query: Query,
  resource: string,
  start: { id: string; launch: PreparedWorkflowLaunch }
): Promise<ResourceStartDisposition> {
  await insertWorkflowRun(query, start.launch.run);
  await query(
    `UPDATE remote_agent_resource_start_requests
        SET status = 'admitted', admitted_at = ${getDialect().now()}, blocker_run_id = NULL
      WHERE id = $1 AND status = 'queued'`,
    [start.id]
  );
  await addResourceSlotHolder(query, resource, { kind: 'run', id: start.id });
  return { status: 'admitted', requestId: start.id, runId: start.id };
}

function disposition(row: RequestRow): ResourceStartDisposition {
  if (row.status === 'admitted') return { status: 'admitted', requestId: row.id, runId: row.id };
  if (row.status === 'skipped' && row.blocker_run_id) {
    return {
      status: 'skipped',
      requestId: row.id,
      blocker: { kind: row.blocker_kind ?? 'run', id: row.blocker_run_id },
    };
  }
  if (row.status === 'queued' && row.blocker_run_id && row.blocker_kind) {
    return {
      status: 'queued',
      requestId: row.id,
      blocker: { kind: row.blocker_kind, id: row.blocker_run_id },
    };
  }
  throw new Error(`Resource start request '${row.id}' has no executable disposition`);
}

async function admitResourceStartWithQuery(
  query: Query,
  intent: ResourceStartIntent
): Promise<ResourceStartDisposition> {
  await lockCheckoutOwnership(query);
  const { capacity } = await lockResourceSlot(query, intent.resource, intent.capacity);
  const existing = await query<RequestRow>(
    'SELECT * FROM remote_agent_resource_start_requests WHERE id = $1',
    [intent.launch.run.id]
  );
  if (existing.rows[0]) return disposition(existing.rows[0]);

  const launch = preparedWorkflowLaunchSchema.parse(intent.launch);
  const blocker = resourceStartBlocker(
    await resourceStartOccupancy(query, intent.resource, capacity),
    launch
  );
  const status = blocker && intent.overlap === 'skip' ? 'skipped' : 'queued';
  await query(
    `INSERT INTO remote_agent_resource_start_requests
       (id, resource_key, host_id, overlap_policy, status, blocker_run_id, blocker_kind, launch, receipt_id, binding_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      intent.launch.run.id,
      intent.resource,
      intent.hostId,
      intent.overlap,
      status,
      blocker?.id ?? null,
      blocker?.kind ?? null,
      JSON.stringify(intent.launch),
      intent.receipt?.receiptId ?? null,
      intent.receipt?.bindingId ?? null,
    ]
  );
  const row: RequestRow = {
    id: intent.launch.run.id,
    resource_key: intent.resource,
    host_id: intent.hostId,
    overlap_policy: intent.overlap,
    status,
    blocker_run_id: blocker?.id ?? null,
    blocker_kind: blocker?.kind ?? null,
    launch: intent.launch,
  };
  return blocker ? disposition(row) : admitExisting(query, intent.resource, { id: row.id, launch });
}

export async function admitResourceStart(
  intent: ResourceStartIntent
): Promise<ResourceStartDisposition> {
  return getDatabase().withTransaction(query => admitResourceStartWithQuery(query, intent));
}

/** Admit this host's queued requests that can run while the slot has free capacity. */
export async function drainResourceStarts(options: {
  resource: string;
  hostId: string;
}): Promise<ResourceStartDisposition[]> {
  return getDatabase().withTransaction(async query => {
    await lockCheckoutOwnership(query);
    const { capacity } = await lockResourceSlot(query, options.resource);
    const slot = await resourceStartOccupancy(query, options.resource, capacity);
    const admitted: ResourceStartDisposition[] = [];
    for (const start of drainableStarts(slot, options.hostId))
      admitted.push(await admitExisting(query, options.resource, start));
    return admitted;
  });
}

export async function hasStartReceiptForDelivery(
  sourceInstanceId: string,
  deliveryId: string
): Promise<boolean> {
  const found = await getDatabase().query(
    'SELECT 1 FROM remote_agent_start_receipts WHERE source_instance_id = $1 AND delivery_id = $2',
    [sourceInstanceId, deliveryId]
  );
  return found.rows.length > 0;
}

export async function acceptStartReceipt(
  input: SourceReceiptAcceptance
): Promise<{ receiptId: string; replay: boolean }> {
  return getDatabase().withTransaction(async query => {
    const inserted = await query(
      `INSERT INTO remote_agent_start_receipts
       (id, source_instance_id, delivery_id, content_digest, received_at, occurred_at, source_actor, outcome, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
         (receipt_id,binding_id,binding_revision,host_id,intent,event_input_names,preparation_status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [
          input.receipt.id,
          binding.bindingId,
          binding.bindingRevision,
          binding.hostId,
          ...storableIntent(binding),
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
  });
}

function parseStoredJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Older binaries parse the `intent` column strictly, so it keeps their shape: event
 * inputs are merged into `launch.inputs` (an older binary passes them through, as it
 * always did) and their names go to `event_input_names`. `readStoredIntent` reverses it.
 */
function storableIntent(binding: ResourceStartBindingIntent): [string, string | null] {
  const { eventInputs, ...intent } = binding;
  if (!eventInputs || Object.keys(eventInputs).length === 0) return [JSON.stringify(intent), null];
  return [
    JSON.stringify({
      ...intent,
      launch: { ...intent.launch, inputs: { ...intent.launch.inputs, ...eventInputs } },
    }),
    JSON.stringify(Object.keys(eventInputs)),
  ];
}

function readStoredIntent(intent: unknown, eventInputNames: unknown): ResourceStartBindingIntent {
  const stored = resourceStartBindingIntentSchema.parse(parseStoredJson(intent));
  if (eventInputNames == null) return stored;
  const names = new Set(z.array(z.string()).parse(parseStoredJson(eventInputNames)));
  for (const name of names)
    if (!Object.hasOwn(stored.launch.inputs, name))
      throw new Error(`Stored binding intent lacks its event input '${name}'`);
  const entries = Object.entries(stored.launch.inputs);
  return {
    ...stored,
    launch: {
      ...stored.launch,
      inputs: Object.fromEntries(entries.filter(([name]) => !names.has(name))),
    },
    eventInputs: Object.fromEntries(entries.filter(([name]) => names.has(name))),
  };
}

function inspectBinding(row: Record<string, unknown>): StartBindingInspection {
  const requestStatus =
    row.request_status === 'queued' ||
    row.request_status === 'admitted' ||
    row.request_status === 'skipped' ||
    row.request_status === 'withdrawn'
      ? row.request_status
      : null;
  let requestDisposition: ResourceStartDisposition | null = null;
  if (
    typeof row.request_id === 'string' &&
    (requestStatus === 'queued' || requestStatus === 'admitted' || requestStatus === 'skipped')
  ) {
    requestDisposition = disposition({
      id: row.request_id,
      resource_key: '',
      host_id: '',
      overlap_policy: 'queue',
      status: requestStatus,
      blocker_run_id: typeof row.request_blocker_id === 'string' ? row.request_blocker_id : null,
      blocker_kind:
        row.request_blocker_kind === 'run' || row.request_blocker_kind === 'request'
          ? row.request_blocker_kind
          : null,
      launch: null,
    });
  }
  return {
    receiptId: String(row.receipt_id),
    bindingId: String(row.binding_id),
    bindingRevision: typeof row.binding_revision === 'string' ? row.binding_revision : null,
    hostId: typeof row.host_id === 'string' ? row.host_id : null,
    status: row.preparation_status as StartBindingInspection['status'],
    ownerId: typeof row.preparation_owner === 'string' ? row.preparation_owner : null,
    error: typeof row.preparation_error === 'string' ? row.preparation_error : null,
    intent: row.intent == null ? null : readStoredIntent(row.intent, row.event_input_names),
    requestStatus,
    disposition: requestDisposition,
  };
}

export async function getStartReceipt(id: string): Promise<StartReceiptInspection | null> {
  const receipt = await getDatabase().query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_start_receipts WHERE id = $1',
    [id]
  );
  if (!receipt.rows[0]) return null;
  const bindings = await getDatabase().query<Record<string, unknown>>(
    `SELECT b.*, r.id AS request_id, r.status AS request_status,
            r.blocker_run_id AS request_blocker_id, r.blocker_kind AS request_blocker_kind
       FROM remote_agent_start_receipt_bindings b
       LEFT JOIN remote_agent_resource_start_requests r
         ON r.receipt_id = b.receipt_id AND r.binding_id = b.binding_id
      WHERE b.receipt_id = $1 ORDER BY b.binding_id`,
    [id]
  );
  const row = receipt.rows[0];
  return {
    id: String(row.id),
    sourceInstanceId: String(row.source_instance_id),
    deliveryId: typeof row.delivery_id === 'string' ? row.delivery_id : null,
    contentDigest: String(row.content_digest),
    receivedAt:
      row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at),
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : typeof row.occurred_at === 'string'
          ? row.occurred_at
          : null,
    sourceActor: sourceReceiptInputSchema.shape.sourceActor.parse(
      parseStoredJson(row.source_actor)
    ),
    outcome: row.outcome as StartReceiptInspection['outcome'],
    reason: typeof row.reason === 'string' ? row.reason : null,
    bindings: bindings.rows.map(inspectBinding),
  };
}

export async function listStartReceipts(
  limit?: number
): Promise<
  Pick<
    StartReceiptInspection,
    'id' | 'sourceInstanceId' | 'deliveryId' | 'outcome' | 'reason' | 'receivedAt'
  >[]
> {
  const receiptLimit = validateStartReceiptLimit(limit);
  // SQLite's date functions round fractions to milliseconds. Keep the schema's UTC precision.
  const receivedAtOrder =
    getDatabase().dialect === 'sqlite'
      ? `CASE WHEN length(received_at) = 17 THEN substr(received_at, 1, 16) || ':00'
              ELSE substr(received_at, 1, 19) END || '.' ||
         CASE WHEN instr(received_at, '.') = 0 THEN ''
              ELSE rtrim(substr(received_at, 21, length(received_at) - 21), '0') END`
      : 'received_at';
  const result = await getDatabase().query<{
    id: string;
    source_instance_id: string;
    delivery_id: string | null;
    outcome: StartReceiptInspection['outcome'];
    reason: string | null;
    received_at: string | Date;
  }>(
    `SELECT id, source_instance_id, delivery_id, outcome, reason, received_at FROM remote_agent_start_receipts ORDER BY ${receivedAtOrder} DESC, id DESC LIMIT $1`,
    [receiptLimit]
  );
  return result.rows.map(row => ({
    id: row.id,
    sourceInstanceId: row.source_instance_id,
    deliveryId: row.delivery_id,
    outcome: row.outcome,
    reason: row.reason,
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
  }));
}

export async function listPendingStartBindings(options: {
  hostId: string;
  limit?: number;
}): Promise<StartBindingInspection[]> {
  const result = await getDatabase().query<Record<string, unknown>>(
    "SELECT * FROM remote_agent_start_receipt_bindings WHERE host_id = $1 AND preparation_status IN ('pending','failed') ORDER BY created_at, binding_id LIMIT $2",
    [options.hostId, options.limit ?? 100]
  );
  return result.rows.map(inspectBinding);
}

function inspectRequest(row: Record<string, unknown>): ResourceStartRequestInspection {
  const runStatus = workflowRunStatusSchema.safeParse(row.run_status);
  const blockerRunStatus = workflowRunStatusSchema.safeParse(row.blocker_run_status);
  return {
    id: String(row.id),
    resource: String(row.resource_key),
    hostId: String(row.host_id),
    overlap: row.overlap_policy as ResourceStartRequestInspection['overlap'],
    status: row.status as ResourceStartRequestInspection['status'],
    runStatus: runStatus.success ? runStatus.data : null,
    blocker:
      (row.blocker_kind === 'run' || row.blocker_kind === 'request') &&
      typeof row.blocker_run_id === 'string'
        ? { kind: row.blocker_kind, id: row.blocker_run_id }
        : null,
    blockerRunStatus: blockerRunStatus.success ? blockerRunStatus.data : null,
    launch: preparedWorkflowLaunchSchema.parse(parseStoredJson(row.launch)),
  };
}

const requestInspectionSelect = `SELECT r.*, own.status AS run_status, w.status AS blocker_run_status
  FROM remote_agent_resource_start_requests r
  LEFT JOIN remote_agent_workflow_runs own ON own.id = r.id
  LEFT JOIN remote_agent_workflow_runs w
    ON r.blocker_kind = 'run' AND w.id = r.blocker_run_id`;

export async function getResourceStartRequest(
  id: string
): Promise<ResourceStartRequestInspection | null> {
  const result = await getDatabase().query<Record<string, unknown>>(
    `${requestInspectionSelect} WHERE r.id = $1`,
    [id]
  );
  return result.rows[0] ? inspectRequest(result.rows[0]) : null;
}

export async function listQueuedResourceStartsForHost(
  hostId: string
): Promise<QueuedResourceStartInspection[]> {
  const result = await getDatabase().query<Record<string, unknown>>(
    `${requestInspectionSelect}
      WHERE r.host_id = $1 AND r.status = 'queued'
      ORDER BY r.resource_key, r.queue_position`,
    [hostId]
  );
  return result.rows.map(row => {
    try {
      parseQueuedResourceStart(row);
      return inspectRequest(row);
    } catch (error) {
      return {
        id: String(row.id),
        resource: String(row.resource_key),
        receiptId: typeof row.receipt_id === 'string' ? row.receipt_id : undefined,
        error,
      };
    }
  });
}

export async function withdrawQueuedResourceStart(
  id: string
): Promise<PreparedWorkflowLaunch | null> {
  return getDatabase().withTransaction(async query => {
    // SQLite transactions are deferred. Write before taking the snapshot so a
    // concurrent commit cannot make the later write fail its lock upgrade.
    if (getDatabase().dialect === 'sqlite') {
      await query('UPDATE remote_agent_resource_start_requests SET id = id WHERE id = $1', [id]);
    }
    const selected = await query<{ launch: unknown }>(
      `SELECT launch FROM remote_agent_resource_start_requests WHERE id = $1 AND status = 'queued'${getDialect().rowLock()}`,
      [id]
    );
    if (!selected.rows[0]) return null;
    const updated = await query(
      "UPDATE remote_agent_resource_start_requests SET status = 'withdrawn' WHERE id = $1 AND status = 'queued'",
      [id]
    );
    return updated.rowCount === 1
      ? preparedWorkflowLaunchSchema.parse(parseStoredJson(selected.rows[0].launch))
      : null;
  });
}

export async function claimStartBindingPreparation(input: {
  receiptId: string;
  bindingId: string;
  ownerId: string;
}): Promise<boolean> {
  const result = await getDatabase().query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'preparing', preparation_owner = $3, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status IN ('pending','failed')`,
    [input.receiptId, input.bindingId, input.ownerId]
  );
  return result.rowCount === 1;
}

export async function completeStartBindingPreparation(input: {
  receiptId: string;
  bindingId: string;
  ownerId: string;
  launch: PreparedWorkflowLaunch;
}): Promise<ResourceStartDisposition | null> {
  return getDatabase().withTransaction(async query => {
    await lockCheckoutOwnership(query);
    const binding = await query<{ intent: unknown }>(
      `SELECT intent FROM remote_agent_start_receipt_bindings
        WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3${getDialect().rowLock()}`,
      [input.receiptId, input.bindingId, input.ownerId]
    );
    const rawIntent = binding.rows[0]?.intent;
    if (!rawIntent) return null;
    const persisted = resourceStartBindingIntentSchema.parse(parseStoredJson(rawIntent));
    const disposition = await admitResourceStartWithQuery(query, {
      resource: persisted.resource,
      capacity: persisted.capacity,
      hostId: persisted.hostId,
      overlap: persisted.overlap,
      launch: input.launch,
      receipt: { receiptId: input.receiptId, bindingId: input.bindingId },
    });
    await query(
      `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'complete', preparation_error = NULL, updated_at = ${getDialect().now()}
        WHERE receipt_id = $1 AND binding_id = $2 AND preparation_owner = $3`,
      [input.receiptId, input.bindingId, input.ownerId]
    );
    return disposition;
  });
}

export async function failStartBindingPreparation(input: {
  receiptId: string;
  bindingId: string;
  ownerId: string;
  retryable: boolean;
  error: string;
}): Promise<boolean> {
  const result = await getDatabase().query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = $4, preparation_error = $5, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3`,
    [
      input.receiptId,
      input.bindingId,
      input.ownerId,
      input.retryable ? 'failed' : 'rejected',
      input.error,
    ]
  );
  return result.rowCount === 1;
}

export async function resetStartBindingPreparation(input: {
  receiptId: string;
  bindingId: string;
  ownerId: string;
}): Promise<boolean> {
  const result = await getDatabase().query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'pending', preparation_owner = NULL, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3`,
    [input.receiptId, input.bindingId, input.ownerId]
  );
  return result.rowCount === 1;
}
