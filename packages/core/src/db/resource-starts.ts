import type {
  PreparedWorkflowLaunch,
  ResourceStartBindingIntent,
  ResourceStartDisposition,
  ResourceStartIntent,
  SourceReceiptInput,
  SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import {
  sourceReceiptInputSchema,
  preparedWorkflowLaunchSchema,
  resourceStartBindingIntentSchema,
} from '@archon/workflows/schemas/resource-start';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDialect } from './connection';
import {
  addResourceSlotHolder,
  liveResourceSlotHolders,
  lockResourceSlot,
  type TransactionQuery as Query,
} from './resource-slots';
import { insertWorkflowRun } from './workflows';

const lock = (): string => (getDatabase().dialect === 'postgres' ? ' FOR UPDATE' : '');

interface RequestRow {
  id: string;
  resource_key: string;
  host_id: string;
  overlap_policy: 'skip' | 'queue';
  status: 'queued' | 'admitted' | 'skipped' | 'withdrawn';
  blocker_run_id: string | null;
  blocker_kind: 'run' | 'request' | null;
  launch: unknown;
}

/** Start requests are the run holder's durable FIFO waiters for a resource slot. */
async function oldestQueuedRequest(query: Query, resource: string): Promise<RequestRow | null> {
  const queued = await query<RequestRow>(
    `SELECT * FROM remote_agent_resource_start_requests
      WHERE resource_key = $1 AND status = 'queued'
      ORDER BY queue_position LIMIT 1${lock()}`,
    [resource]
  );
  return queued.rows[0] ?? null;
}

async function admitExisting(query: Query, row: RequestRow): Promise<ResourceStartDisposition> {
  const launch = preparedWorkflowLaunchSchema.parse(
    typeof row.launch === 'string' ? JSON.parse(row.launch) : row.launch
  );
  await insertWorkflowRun(query, launch.run);
  await query(
    `UPDATE remote_agent_resource_start_requests
        SET status = 'admitted', admitted_at = ${getDialect().now()}, blocker_run_id = NULL
      WHERE id = $1 AND status = 'queued'`,
    [row.id]
  );
  await addResourceSlotHolder(query, row.resource_key, { kind: 'run', id: row.id });
  return { status: 'admitted', requestId: row.id, runId: row.id };
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
  const { capacity } = await lockResourceSlot(query, intent.resource, intent.capacity);
  const existing = await query<RequestRow>(
    'SELECT * FROM remote_agent_resource_start_requests WHERE id = $1',
    [intent.launch.run.id]
  );
  if (existing.rows[0]) return disposition(existing.rows[0]);

  // An older waiter keeps FIFO even when a slot is free, so a new arrival cannot pass it.
  const older = await oldestQueuedRequest(query, intent.resource);
  const holders = await liveResourceSlotHolders(query, intent.resource);
  const blocker: { kind: 'run' | 'request'; id: string } | null = older
    ? { kind: 'request', id: older.id }
    : holders.length >= capacity && holders[0]
      ? { kind: 'run', id: holders[0].id }
      : null;
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
  return blocker ? disposition(row) : admitExisting(query, row);
}

export async function admitResourceStart(
  intent: ResourceStartIntent
): Promise<ResourceStartDisposition> {
  return getDatabase().withTransaction(query => admitResourceStartWithQuery(query, intent));
}

/**
 * Admit this host's queued requests while the slot has free capacity. Stops at the first
 * queued request that belongs to another host: FIFO order is per resource, not per host.
 */
export async function drainResourceStarts(options: {
  resource: string;
  hostId: string;
}): Promise<ResourceStartDisposition[]> {
  return getDatabase().withTransaction(async query => {
    const { capacity } = await lockResourceSlot(query, options.resource);
    let free = capacity - (await liveResourceSlotHolders(query, options.resource)).length;
    const admitted: ResourceStartDisposition[] = [];
    while (free > 0) {
      const head = await oldestQueuedRequest(query, options.resource);
      if (head?.host_id !== options.hostId) break;
      admitted.push(await admitExisting(query, head));
      free -= 1;
    }
    return admitted;
  });
}

export class SourceReceiptDigestConflictError extends Error {}

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
         (receipt_id,binding_id,binding_revision,host_id,intent,preparation_status)
         VALUES ($1,$2,$3,$4,$5,'pending')`,
        [
          input.receipt.id,
          binding.bindingId,
          binding.bindingRevision,
          binding.hostId,
          JSON.stringify(binding),
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

export interface StartBindingInspection {
  receiptId: string;
  bindingId: string;
  bindingRevision: string | null;
  hostId: string | null;
  status: 'pending' | 'preparing' | 'failed' | 'rejected' | 'unmatched' | 'complete';
  ownerId: string | null;
  error: string | null;
  intent: ResourceStartBindingIntent | null;
  requestStatus: ResourceStartRequestInspection['status'] | null;
  disposition: ResourceStartDisposition | null;
}

export interface StartReceiptInspection {
  id: string;
  sourceInstanceId: string;
  deliveryId: string | null;
  contentDigest: string;
  receivedAt: string;
  occurredAt: string | null;
  sourceActor: SourceReceiptInput['sourceActor'];
  outcome: 'matched' | 'unmatched' | 'unsupported' | 'malformed';
  reason: string | null;
  bindings: StartBindingInspection[];
}

function parseStoredJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
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
    intent:
      row.intent == null
        ? null
        : resourceStartBindingIntentSchema.parse(parseStoredJson(row.intent)),
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
  limit = 50
): Promise<
  Pick<
    StartReceiptInspection,
    'id' | 'sourceInstanceId' | 'deliveryId' | 'outcome' | 'reason' | 'receivedAt'
  >[]
> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Receipt limit must be an integer from 1 to 1000.');
  const result = await getDatabase().query<{
    id: string;
    source_instance_id: string;
    delivery_id: string | null;
    outcome: StartReceiptInspection['outcome'];
    reason: string | null;
    received_at: string | Date;
  }>(
    'SELECT id, source_instance_id, delivery_id, outcome, reason, received_at FROM remote_agent_start_receipts ORDER BY received_at DESC, id DESC LIMIT $1',
    [limit]
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

export interface ResourceStartRequestInspection {
  id: string;
  resource: string;
  hostId: string;
  overlap: 'skip' | 'queue';
  status: 'queued' | 'admitted' | 'skipped' | 'withdrawn';
  runStatus: WorkflowRunStatus | null;
  blocker: { kind: 'run' | 'request'; id: string } | null;
  blockerRunStatus: WorkflowRunStatus | null;
  launch: PreparedWorkflowLaunch;
}

function inspectRequest(row: Record<string, unknown>): ResourceStartRequestInspection {
  const runStatus = workflowRunStatusSchema.safeParse(row.run_status);
  const blockerRunStatus = workflowRunStatusSchema.safeParse(row.blocker_run_status);
  return {
    id: String(row.id),
    resource: String(row.resource_key),
    hostId: String(row.host_id),
    overlap: row.overlap_policy as 'skip' | 'queue',
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
): Promise<ResourceStartRequestInspection[]> {
  const result = await getDatabase().query<Record<string, unknown>>(
    `${requestInspectionSelect}
      WHERE r.host_id = $1 AND r.status = 'queued'
      ORDER BY r.resource_key, r.queue_position`,
    [hostId]
  );
  return result.rows.map(inspectRequest);
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
      `SELECT launch FROM remote_agent_resource_start_requests WHERE id = $1 AND status = 'queued'${lock()}`,
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
    // See withdrawQueuedResourceStart: acquire SQLite's writer lock before the read.
    if (getDatabase().dialect === 'sqlite') {
      await query(
        'UPDATE remote_agent_start_receipt_bindings SET binding_id = binding_id WHERE receipt_id = $1 AND binding_id = $2',
        [input.receiptId, input.bindingId]
      );
    }
    const binding = await query<{ intent: unknown }>(
      `SELECT intent FROM remote_agent_start_receipt_bindings
        WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3${lock()}`,
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
