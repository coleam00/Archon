import { randomUUID } from 'node:crypto';
import {
  approvalContextSchema,
  pendingGateSchema,
  gateProjection,
  gateResponseSchema,
  isApprovalContext,
  isGateResolved,
  isWorkflowWaitContext,
  readGateQueue,
  readSubrunMetadata,
  type ApprovalContext,
  type GateAdmission,
  type GateQueue,
  type PendingGate,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDatabaseType, getDialect } from './connection';
import { serializeNodeStateRecord } from '@archon/workflows/node-record-serialization';
import { reportRunTerminal } from './workflow-terminal-telemetry';
import { insertTerminalWorkflowEvent } from './workflow-terminal-event';
import type { GateResolutionEvent } from './workflows';
import type { WorkflowCancellationEventDetails } from '@archon/workflows/store';
import { normalizeWorkflowRun } from './workflow-run-normalization';
import { insertWorkflowEvent } from './workflow-events';
import type { TransactionQuery } from './resource-slots';

class MissingGateRunError extends Error {
  constructor(readonly runId: string) {
    super(`Gate admission run ${runId} is missing`);
  }
}

async function readRun(
  query: TransactionQuery,
  id: string,
  lock = false
): Promise<WorkflowRun | null> {
  const result = await query<WorkflowRun>(
    `SELECT * FROM remote_agent_workflow_runs WHERE id = $1${lock && getDatabaseType() === 'postgresql' ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return result.rows[0] ? normalizeWorkflowRun(result.rows[0]) : null;
}

async function ancestry(query: TransactionQuery, id: string): Promise<WorkflowRun[]> {
  const chain: WorkflowRun[] = [];
  const seen = new Set<string>();
  let next: string | null = id;
  while (next !== null) {
    if (seen.has(next)) throw new Error('Cycle in workflow gate ancestry');
    seen.add(next);
    const row = await readRun(query, next);
    if (!row) throw new MissingGateRunError(next);
    chain.unshift(row);
    next = row.parent_run_id;
  }
  return chain;
}

/** All mutations of one run tree acquire its root before any descendant row. */
async function lockTree(query: TransactionQuery, runId: string): Promise<WorkflowRun[]> {
  if (getDatabaseType() === 'sqlite') {
    // SQLite must take its writer lock before the first read snapshot.
    await query('UPDATE remote_agent_workflow_runs SET id = id WHERE id = $1', [runId]);
  }
  const chain = await ancestry(query, runId);
  const locked: WorkflowRun[] = [];
  for (const row of chain) {
    const current = await readRun(query, row.id, true);
    if (current?.parent_run_id !== row.parent_run_id) {
      throw new Error('Workflow ancestry changed during gate admission');
    }
    locked.push(current);
  }
  return locked;
}

async function writeRun(query: TransactionQuery, run: WorkflowRun): Promise<void> {
  await query('UPDATE remote_agent_workflow_runs SET status = $2, metadata = $3 WHERE id = $1', [
    run.id,
    run.status,
    JSON.stringify(run.metadata),
  ]);
}

function snapshot(context: ApprovalContext): PendingGate['context'] {
  return pendingGateSchema.shape.context.strip().parse(context);
}

function readRootQueue(root: WorkflowRun): GateQueue | undefined {
  const queue = readGateQueue(root.metadata);
  if (
    !queue &&
    isApprovalContext(root.metadata.approval) &&
    root.metadata.approval.admissionOwnerId !== undefined
  )
    throw new Error('Gate projection has no admission queue');
  return queue;
}

async function normalizeLegacyQueue(
  query: TransactionQuery,
  root: WorkflowRun
): Promise<GateQueue> {
  const existing = readRootQueue(root);
  if (existing) return existing;
  const queue: GateQueue = {
    version: 1,
    phase: 'collecting',
    active: null,
    pending: [],
    resolved: [],
  };
  if (
    root.metadata.approval === undefined ||
    (root.status !== 'paused' &&
      !(isApprovalContext(root.metadata.approval) && isGateResolved(root.metadata.approval)))
  )
    return queue;
  let leaf = root;
  const seen = new Set<string>();
  while (
    isApprovalContext(leaf.metadata.approval) &&
    leaf.metadata.approval.type === 'child_workflow'
  ) {
    if (seen.has(leaf.id)) throw new Error('Cycle in legacy child gate pointers');
    seen.add(leaf.id);
    const childId = leaf.metadata.approval.childRunId;
    const child = childId ? await readRun(query, childId, true) : null;
    if (child?.parent_run_id !== leaf.id)
      throw new Error('Legacy child gate pointer is unreadable');
    leaf = child;
  }
  const context = leaf.metadata.approval;
  if (
    context === undefined &&
    leaf.id !== root.id &&
    (leaf.status === 'running' ||
      (leaf.status === 'paused' && isWorkflowWaitContext(leaf.metadata.wait)))
  )
    return queue;
  if (!isApprovalContext(context)) throw new Error('Admission owner has no readable gate');
  const record: PendingGate = {
    id: context.gateId ?? randomUUID(),
    runId: leaf.id,
    context: snapshot(context),
    readyForPresentation: true,
    presentation: 'delivered',
  };
  queue.phase = root.status === 'paused' ? 'parked' : 'collecting';
  if (isGateResolved(context)) {
    queue.resolved.push({
      ...record,
      response: gateResponseSchema.parse({
        ...leaf.metadata,
        resolved: context.resolved,
      }),
    });
  } else {
    queue.active = record;
  }
  return queue;
}

function stopped(chain: WorkflowRun[]): WorkflowRun | undefined {
  return chain.find(row => row.status !== 'running' && row.status !== 'paused');
}

function parentNodeId(run: WorkflowRun): string {
  const nodeId = readSubrunMetadata(run.metadata).parentNodeId;
  if (typeof nodeId !== 'string' || nodeId === '')
    throw new Error('Child gate has no parent node identity');
  return nodeId;
}

/** Write attention from the selected leaf; queued contexts never own the human slot. */
async function projectQueue(
  query: TransactionQuery,
  root: WorkflowRun,
  queue: GateQueue
): Promise<void> {
  const freshRoot = await readRun(query, root.id, true);
  if (!freshRoot) throw new Error('Gate admission owner disappeared');
  root.metadata = { ...freshRoot.metadata, gate_queue: queue };
  root.status = freshRoot.status;
  const records = [...(queue.active ? [queue.active] : []), ...queue.pending];
  // Install queued projections first so the selected chain wins shared ancestors.
  for (const gate of records.slice().reverse()) {
    const chain = await ancestry(query, gate.runId);
    if (chain[0]?.id !== root.id) throw new Error('Gate belongs to a different admission tree');
    for (let i = 0; i < chain.length; i++) {
      const row = await readRun(query, chain[i].id, true);
      if (!row) throw new Error('Gate projection run disappeared');
      if (row.status !== 'running' && row.status !== 'paused') continue;
      const projection = gateProjection(queue, gate, root.id);
      const child = chain[i + 1];
      row.status = 'paused';
      row.metadata = {
        ...row.metadata,
        approval: child
          ? {
              ...projection,
              type: 'child_workflow',
              nodeId: parentNodeId(child),
              childRunId: child.id,
            }
          : projection,
        ...(row.id === root.id ? { gate_queue: queue } : {}),
      };
      await writeRun(query, row);
      if (row.id === root.id) root.metadata = row.metadata;
    }
  }
  if (records.length > 0) root.status = 'paused';
  if (records.length === 0) {
    const latest = queue.resolved
      .slice()
      .reverse()
      .find(gate => gate.runId === root.id);
    const machineBlock =
      isApprovalContext(root.metadata.approval) && root.metadata.approval.type === 'child_workflow'
        ? snapshot(root.metadata.approval)
        : undefined;
    const projection = latest
      ? {
          ...latest.context,
          resolved: latest.response.resolved,
          gateId: latest.id,
        }
      : machineBlock;
    if (projection) root.metadata.approval = projection;
    else delete root.metadata.approval;
  }
  await writeRun(query, root);
}

export async function registerWorkflowGate(
  runId: string,
  context: ApprovalContext,
  extraMetadata?: Record<string, unknown>
): Promise<GateAdmission> {
  return getDatabase()
    .withTransaction<GateAdmission>(async query => {
      const chain = await lockTree(query, runId);
      const root = chain[0];
      const owner = chain[chain.length - 1];
      const external = stopped(chain);
      if (external)
        return { status: 'externally_stopped', runId: external.id, runStatus: external.status };
      if (chain.some(row => row.metadata.wait != null)) {
        throw new Error('A durable wait and a human gate cannot share an admission owner');
      }
      const queue = await normalizeLegacyQueue(query, root);
      // Parent child blocks describe existing governed work, never a second human decision.
      if (context.type === 'child_workflow') {
        const gate = [queue.active, ...queue.pending].find(
          gate => gate && chain.some(row => row.id === gate.runId)
        );
        if (gate)
          return {
            status: 'registered',
            ownerId: root.id,
            gateId: gate.id,
            position: gate.id === queue.active?.id ? 'active' : 'queued',
          };
        const childRecords = [queue.active, ...queue.pending].filter(
          (gate): gate is PendingGate => gate !== null
        );
        for (const gate of childRecords) {
          const path = await ancestry(query, gate.runId);
          if (path.some(row => row.id === context.childRunId)) {
            return {
              status: 'registered',
              ownerId: root.id,
              gateId: gate.id,
              position: gate.id === queue.active?.id ? 'active' : 'queued',
            };
          }
        }
        const child = context.childRunId ? await readRun(query, context.childRunId, true) : null;
        if (child?.parent_run_id !== runId || !['running', 'paused'].includes(child.status))
          throw new Error('Child block does not identify governed non-terminal work');
        owner.status = 'paused';
        owner.metadata = { ...owner.metadata, ...extraMetadata, approval: snapshot(context) };
        await writeRun(query, owner);
        return { status: 'blocked_on_child', ownerId: root.id };
      }
      const unresolved = [...(queue.active ? [queue.active] : []), ...queue.pending];
      const prior = unresolved.find(
        gate =>
          gate.runId === runId &&
          (context.gateId !== undefined
            ? gate.id === context.gateId
            : context.execution !== undefined &&
              gate.context.execution?.invocation.id === context.execution.invocation.id &&
              gate.context.execution?.path === context.execution.path &&
              gate.context.iteration === context.iteration)
      );
      if (prior)
        return {
          status: 'registered',
          ownerId: root.id,
          gateId: prior.id,
          position: prior.id === queue.active?.id ? 'active' : 'queued',
        };
      if (context.gateId !== undefined) {
        const resolved = queue.resolved.find(
          gate => gate.id === context.gateId && gate.runId === runId
        );
        if (resolved) return { status: 'already_resolved', ownerId: root.id, gate: resolved };
        if ([...unresolved, ...queue.resolved].some(gate => gate.id === context.gateId)) {
          throw new Error('Gate identity belongs to a different run');
        }
      }
      const predecessor = queue.resolved
        .slice()
        .reverse()
        .find(gate => gate.runId === runId && gate.context.nodeId === context.nodeId);
      if (predecessor) {
        context = {
          ...context,
          rejectionCount:
            predecessor.response.rejection_count ?? predecessor.context.rejectionCount,
        };
        queue.resolved = queue.resolved.filter(
          gate => gate.runId !== runId || gate.context.nodeId !== context.nodeId
        );
      }
      const record: PendingGate = {
        id: context.gateId ?? randomUUID(),
        runId,
        context: snapshot(context),
        readyForPresentation: false,
        presentation: 'unclaimed',
      };
      const position = queue.active ? 'queued' : 'active';
      if (queue.active) queue.pending.push(record);
      else queue.active = record;
      owner.metadata = { ...owner.metadata, ...extraMetadata };
      await writeRun(query, owner);
      await projectQueue(query, root, queue);
      return { status: 'registered', ownerId: root.id, gateId: record.id, position };
    })
    .catch((error: unknown) => {
      if (error instanceof MissingGateRunError)
        return {
          status: 'externally_stopped' as const,
          runId: error.runId,
          runStatus: null,
        };
      throw error;
    });
}

export async function settleWorkflowGates(runId: string): Promise<string> {
  return getDatabase().withTransaction(async query => {
    const chain = await lockTree(query, runId);
    const root = chain[0];
    if (stopped(chain)) return root.id;
    const queue = readRootQueue(root);
    if (!queue) return root.id;
    for (const gate of [...(queue.active ? [queue.active] : []), ...queue.pending]) {
      if (gate.runId === runId) gate.readyForPresentation = true;
    }
    if (root.id === runId) queue.phase = 'parked';
    await projectQueue(query, root, queue);
    return root.id;
  });
}

export async function claimWorkflowGatePresentation(runId: string): Promise<PendingGate | null> {
  return getDatabase().withTransaction(async query => {
    const chain = await lockTree(query, runId);
    const root = chain[0];
    if (stopped(chain)) return null;
    const queue = readRootQueue(root);
    const gate = queue?.active;
    if (
      queue?.phase !== 'parked' ||
      !gate?.readyForPresentation ||
      gate.presentation !== 'unclaimed'
    )
      return null;
    const leaf = await readRun(query, gate.runId, true);
    if (leaf?.status !== 'paused') return null;
    gate.presentation = 'claimed';
    await insertWorkflowEvent(query, {
      workflow_run_id: gate.runId,
      event_type: 'approval_requested',
      step_name: gate.context.execution?.path ?? gate.context.nodeId,
      data: {
        message: gate.context.message,
        iteration: gate.context.iteration,
        completionSignaled: gate.context.completionSignaled,
        gate_id: gate.id,
        admission_owner_id: root.id,
      },
    });
    await projectQueue(query, root, queue);
    return gate;
  });
}

export async function confirmWorkflowGatePresentation(
  runId: string,
  gateId: string
): Promise<{ active: boolean }> {
  return getDatabase().withTransaction(async query => {
    const chain = await lockTree(query, runId);
    const root = chain[0];
    const queue = readRootQueue(root);
    if (!queue) throw new Error('Presentation confirmation has no admission queue');
    const gate = [queue.active, ...queue.resolved].find(gate => gate?.id === gateId);
    if (gate?.presentation !== 'claimed')
      throw new Error('Presentation confirmation does not match its gate');
    gate.presentation = 'delivered';
    if (stopped(chain)) {
      root.metadata = { ...root.metadata, gate_queue: queue };
      await writeRun(query, root);
    } else {
      await projectQueue(query, root, queue);
    }
    return { active: queue.active?.id === gateId && !stopped(chain) };
  });
}

export interface GateResolutionResult {
  resolved: boolean;
  admissionOwnerId?: string;
  promotedGateId?: string;
  terminalRunIds?: string[];
}

/** null means legacy singular metadata; false means an exact modern gate lost its CAS. */
export async function resolveWorkflowGate(
  runId: string,
  expectedGateId: string | undefined,
  metadata: Record<string, unknown>,
  events: GateResolutionEvent[],
  cancellation?: WorkflowCancellationEventDetails
): Promise<GateResolutionResult | null> {
  return getDatabase().withTransaction(async query => {
    const chain = await lockTree(query, runId);
    const root = chain[0];
    const owner = chain[chain.length - 1];
    const queue = readRootQueue(root);
    if (!queue) return null;
    const gate = queue.active;
    if (
      stopped(chain) ||
      owner.status !== 'paused' ||
      queue.phase !== 'parked' ||
      !gate?.readyForPresentation ||
      gate.presentation === 'unclaimed' ||
      gate.runId !== runId ||
      gate.id !== expectedGateId
    )
      return { resolved: false };
    for (const event of events) {
      await insertWorkflowEvent(query, {
        workflow_run_id: runId,
        ...event,
        data: { ...event.data, gate_id: gate.id, admission_owner_id: root.id },
      });
    }
    if (cancellation) {
      await query(
        `UPDATE remote_agent_workflow_runs SET status = 'cancelled', completed_at = ${getDialect().now()} WHERE id = $1`,
        [runId]
      );
      await insertTerminalWorkflowEvent(query, {
        workflow_run_id: runId,
        event_type: 'workflow_cancelled',
        step_name: cancellation.step_name,
        data: {
          cancel_reason: 'approval_rejected',
          ...(cancellation.reason ? { reason: cancellation.reason } : {}),
        },
      });
      for (const ancestor of chain.slice(0, -1)) {
        const error = `Child ${runId} was cancelled at gate ${gate.id}`;
        await query(
          `UPDATE remote_agent_workflow_runs SET status = 'failed', metadata = $2, completed_at = ${getDialect().now()} WHERE id = $1`,
          [ancestor.id, JSON.stringify({ ...ancestor.metadata, error })]
        );
        await insertTerminalWorkflowEvent(query, {
          workflow_run_id: ancestor.id,
          event_type: 'workflow_failed',
          data: { error, gate_id: gate.id, exit_reason: 'unknown' },
        });
      }
      // A terminal decision does not manufacture decisions for the queued requests.
      return {
        resolved: true,
        admissionOwnerId: root.id,
        terminalRunIds: chain.map(row => row.id),
      };
    }
    const context = approvalContextSchema.parse(metadata.approval);
    const response = gateResponseSchema.parse({ ...metadata, resolved: context.resolved });
    queue.resolved.push({ ...gate, response });
    queue.active = queue.pending.shift() ?? null;
    owner.metadata = {
      ...owner.metadata,
      approval: { ...gate.context, resolved: response.resolved, gateId: gate.id },
    };
    await writeRun(query, owner);
    await projectQueue(query, root, queue);
    return {
      resolved: true,
      admissionOwnerId: root.id,
      ...(queue.active ? { promotedGateId: queue.active.id } : {}),
    };
  });
}

export async function getWorkflowGateState(
  runId: string
): Promise<{ ownerId: string; queue?: GateQueue }> {
  return getDatabase().withTransaction(async query => {
    const chain = await ancestry(query, runId);
    const root = chain[0];
    return { ownerId: root.id, queue: readRootQueue(root) };
  });
}

/** Guard continuation under the same root lock as admission and decisions. */
export async function claimWorkflowGateContinuation(
  query: TransactionQuery,
  runId: string
): Promise<boolean> {
  if (getDatabaseType() === 'sqlite')
    await query('UPDATE remote_agent_workflow_runs SET id = id WHERE id = $1', [runId]);
  const found = await readRun(query, runId);
  if (!found) return true;
  const chain = await lockTree(query, runId);
  const root = chain[0];
  const queue = readRootQueue(root);
  if (!queue) return true;
  const unresolved = [...(queue.active ? [queue.active] : []), ...queue.pending];
  if (unresolved.some(gate => gate.runId === runId) || (root.id === runId && unresolved.length > 0))
    return false;
  if (queue.phase === 'collecting' && unresolved.length > 0) return false;
  if (root.id === runId) {
    queue.phase = 'collecting';
    root.metadata = { ...root.metadata, gate_queue: queue };
    await writeRun(query, root);
  }
  return true;
}

export async function consumeWorkflowGateContinuation(
  runId: string,
  gateId: string
): Promise<void> {
  await getDatabase().withTransaction(async query => {
    const chain = await lockTree(query, runId);
    const root = chain[0];
    const owner = chain[chain.length - 1];
    const queue = readRootQueue(root);
    if (!queue) throw new Error('Gate continuation has no admission queue');
    queue.resolved = queue.resolved.filter(gate => gate.runId !== runId || gate.id !== gateId);
    if (isApprovalContext(owner.metadata.approval) && owner.metadata.approval.gateId === gateId) {
      delete owner.metadata.approval;
      await writeRun(query, owner);
    }
    root.metadata = { ...root.metadata, gate_queue: queue };
    if (root.id === owner.id) root.metadata = { ...owner.metadata, gate_queue: queue };
    await writeRun(query, root);
  });
}

export async function failWorkflowGatePresentation(
  runId: string,
  gateId: string,
  error: string
): Promise<{ failed: boolean }> {
  const failedIds = await getDatabase().withTransaction(async query => {
    const chain = await lockTree(query, runId);
    const root = chain[0];
    const queue = readRootQueue(root);
    const gate = queue?.active;
    if (stopped(chain) || gate?.id !== gateId || gate.presentation !== 'claimed') return [];
    const leaf = await readRun(query, gate.runId, true);
    if (leaf?.status !== 'paused') return [];
    if (gate.context.execution) {
      await insertWorkflowEvent(
        query,
        serializeNodeStateRecord({
          ...gate.context.execution,
          lifecycle: { status: 'failed', error, failureKind: 'unknown' },
        })
      );
    }
    const ids = root.id === leaf.id ? [root.id] : [leaf.id, root.id];
    for (const id of ids) {
      const row = id === root.id ? root : leaf;
      await query(
        `UPDATE remote_agent_workflow_runs SET status = 'failed', metadata = $2, completed_at = ${getDialect().now()} WHERE id = $1`,
        [id, JSON.stringify({ ...row.metadata, error })]
      );
      await insertTerminalWorkflowEvent(query, {
        workflow_run_id: id,
        event_type: 'workflow_failed',
        data: { error, gate_id: gateId, exit_reason: 'unknown' },
      });
    }
    return ids;
  });
  for (const id of failedIds) await reportRunTerminal(id);
  return { failed: failedIds.length > 0 };
}

export async function reconcileWorkflowGateChild(childId: string): Promise<void> {
  const terminal = await getDatabase().withTransaction(async query => {
    const chain = await lockTree(query, childId);
    const root = chain[0];
    const child = chain[chain.length - 1];
    if (
      root.id === child.id ||
      !['running', 'paused'].includes(root.status) ||
      ['running', 'paused', 'pending'].includes(child.status)
    )
      return null;
    const queue = readRootQueue(root);
    if (!queue) return null;
    for (const gate of [...(queue.active ? [queue.active] : []), ...queue.pending]) {
      if (!(await ancestry(query, gate.runId)).some(row => row.id === childId)) continue;
      const error = `Child ${childId} ended with an unresolved gate (${gate.id}, status ${child.status})`;
      await query(
        `UPDATE remote_agent_workflow_runs SET status = 'failed', metadata = $2, completed_at = ${getDialect().now()} WHERE id = $1`,
        [root.id, JSON.stringify({ ...root.metadata, error })]
      );
      await insertTerminalWorkflowEvent(query, {
        workflow_run_id: root.id,
        event_type: 'workflow_failed',
        data: { error, gate_id: gate.id, exit_reason: 'unknown' },
      });
      return root.id;
    }
    return null;
  });
  if (terminal) await reportRunTerminal(terminal);
}
