import { inMemoryEventRows, type InMemoryStoreEvent } from '../test-utils';
import { readEventsForRuns } from './test-events';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import type { IWorkflowStore } from '../store';
import {
  FAN_OUT_CANCEL_REASONS,
  waitCompletionEvents,
  WorkflowRunPauseConflictError,
} from '../store';
import type { WorkflowRun, WorkflowWaitContext } from '../schemas/workflow-run';

// A run in one of these statuses still holds the ancestor-aware path lock; this
// must stay in lockstep with the production collision check in dag-executor.ts.
export const holdsPathLock = (status: WorkflowRun['status']): boolean =>
  status === 'pending' || status === 'running' || status === 'paused';

// ---------------------------------------------------------------------------
// Stateful in-memory store — implements just enough of IWorkflowStore to drive
// the real run lifecycle (create / pause / resume / complete / fail / cancel),
// event log (for DAG resume snapshots), the run tree (findChildRuns /
// getRunAncestry), and the ancestor-aware path lock.
// ---------------------------------------------------------------------------

export class InMemoryStore implements IWorkflowStore {
  getWorkflowEventHead: IWorkflowStore['getWorkflowEventHead'] = async () => {
    throw new Error('Unexpected event feed read');
  };
  readWorkflowEventsAfter: IWorkflowStore['readWorkflowEventsAfter'] = async () => {
    throw new Error('Unexpected event feed read');
  };
  getStateDocument: IWorkflowStore['getStateDocument'] = async () => {
    throw new Error('Unexpected getStateDocument');
  };
  putStateDocument: IWorkflowStore['putStateDocument'] = async () => {
    throw new Error('Unexpected putStateDocument');
  };
  patchStateDocument: IWorkflowStore['patchStateDocument'] = async () => {
    throw new Error('Unexpected patchStateDocument');
  };
  deleteStateDocument: IWorkflowStore['deleteStateDocument'] = async () => {
    throw new Error('Unexpected deleteStateDocument');
  };
  listStateRevisions: IWorkflowStore['listStateRevisions'] = async () => {
    throw new Error('Unexpected listStateRevisions');
  };
  listStateDocuments: IWorkflowStore['listStateDocuments'] = async () => {
    throw new Error('Unexpected listStateDocuments');
  };
  getStateDocuments: IWorkflowStore['getStateDocuments'] = async () => {
    throw new Error('Unexpected getStateDocuments');
  };
  pruneStateRevisions: IWorkflowStore['pruneStateRevisions'] = async () => {
    throw new Error('Unexpected pruneStateRevisions');
  };
  admitResourceStart: IWorkflowStore['admitResourceStart'] = async () => {
    throw new Error('Unexpected admitResourceStart');
  };
  drainResourceStarts: IWorkflowStore['drainResourceStarts'] = async () => {
    throw new Error('Unexpected drainResourceStarts');
  };
  hasStartReceiptForDelivery: IWorkflowStore['hasStartReceiptForDelivery'] = async () => {
    throw new Error('Unexpected hasStartReceiptForDelivery');
  };
  acceptStartReceipt: IWorkflowStore['acceptStartReceipt'] = async () => {
    throw new Error('Unexpected acceptStartReceipt');
  };
  getStartReceipt: IWorkflowStore['getStartReceipt'] = async () => {
    throw new Error('Unexpected getStartReceipt');
  };
  listStartReceipts: IWorkflowStore['listStartReceipts'] = async () => {
    throw new Error('Unexpected listStartReceipts');
  };
  listPendingStartBindings: IWorkflowStore['listPendingStartBindings'] = async () => {
    throw new Error('Unexpected listPendingStartBindings');
  };
  getResourceStartRequest: IWorkflowStore['getResourceStartRequest'] = async () => {
    throw new Error('Unexpected getResourceStartRequest');
  };
  listQueuedResourceStartsForHost: IWorkflowStore['listQueuedResourceStartsForHost'] = async () => {
    throw new Error('Unexpected listQueuedResourceStartsForHost');
  };
  withdrawQueuedResourceStart: IWorkflowStore['withdrawQueuedResourceStart'] = async () => {
    throw new Error('Unexpected withdrawQueuedResourceStart');
  };
  claimStartBindingPreparation: IWorkflowStore['claimStartBindingPreparation'] = async () => {
    throw new Error('Unexpected claimStartBindingPreparation');
  };
  completeStartBindingPreparation: IWorkflowStore['completeStartBindingPreparation'] = async () => {
    throw new Error('Unexpected completeStartBindingPreparation');
  };
  failStartBindingPreparation: IWorkflowStore['failStartBindingPreparation'] = async () => {
    throw new Error('Unexpected failStartBindingPreparation');
  };
  resetStartBindingPreparation: IWorkflowStore['resetStartBindingPreparation'] = async () => {
    throw new Error('Unexpected resetStartBindingPreparation');
  };

  listDueWorkflowContinuations: IWorkflowStore['listDueWorkflowContinuations'] = () => {
    throw new Error('Unexpected listDueWorkflowContinuations');
  };
  deferWorkflowContinuation: IWorkflowStore['deferWorkflowContinuation'] = () => {
    throw new Error('Unexpected deferWorkflowContinuation');
  };
  releaseRunForUnreadableSource: IWorkflowStore['releaseRunForUnreadableSource'] = () => {
    throw new Error('Unexpected releaseRunForUnreadableSource');
  };
  releasePausedRunSlot: IWorkflowStore['releasePausedRunSlot'] = async () => ({
    released: false,
  });
  answerAttentionWait: IWorkflowStore['answerAttentionWait'] = () => {
    throw new Error('Unexpected answerAttentionWait');
  };
  labelAttentionWait: IWorkflowStore['labelAttentionWait'] = () => {
    throw new Error('Unexpected labelAttentionWait');
  };
  listAttentionQueueRows: IWorkflowStore['listAttentionQueueRows'] = () => {
    throw new Error('Unexpected listAttentionQueueRows');
  };
  signalWorkflowWait: IWorkflowStore['signalWorkflowWait'] = () => {
    throw new Error('Unexpected signalWorkflowWait');
  };

  resolveApprovalGate: IWorkflowStore['resolveApprovalGate'] = () => {
    throw new Error('Unexpected resolveApprovalGate');
  };
  resolveAndCancelApprovalGate: IWorkflowStore['resolveAndCancelApprovalGate'] = () => {
    throw new Error('Unexpected resolveAndCancelApprovalGate');
  };
  cancelResumableRunsForConversation: IWorkflowStore['cancelResumableRunsForConversation'] = () => {
    throw new Error('Unexpected cancelResumableRunsForConversation');
  };
  deleteWorkflowNodeSessions: IWorkflowStore['deleteWorkflowNodeSessions'] = () => {
    throw new Error('Unexpected deleteWorkflowNodeSessions');
  };
  findOpenWorkRuns: IWorkflowStore['findOpenWorkRuns'] = async () => {
    throw new Error('Not used by this test');
  };
  findAdoptingRuns: IWorkflowStore['findAdoptingRuns'] = async () => {
    throw new Error('Not used by this test');
  };
  deleteOldWorkflowRuns: IWorkflowStore['deleteOldWorkflowRuns'] = async () => {
    throw new Error('Not used by this test');
  };
  listWorkflowEvents: IWorkflowStore['listWorkflowEvents'] = async runId =>
    inMemoryEventRows(this.events).filter(event => event.workflow_run_id === runId);
  listEventsForRuns: IWorkflowStore['listEventsForRuns'] = async (ids, types) =>
    readEventsForRuns(this.events, ids, types);
  listMetricRecords: IWorkflowStore['listMetricRecords'] = async () => [];
  findWorkflowRunsByIdPrefix: IWorkflowStore['findWorkflowRunsByIdPrefix'] = async () => [];
  listWorkflowRuns: IWorkflowStore['listWorkflowRuns'] = () => {
    throw new Error('Unexpected listWorkflowRuns');
  };
  runs = new Map<string, WorkflowRun>();
  events: InMemoryStoreEvent[] = [];
  private seq = 0;

  private clone(r: WorkflowRun): WorkflowRun {
    return { ...r, metadata: { ...r.metadata } };
  }

  createWorkflowRun: IWorkflowStore['createWorkflowRun'] = data => {
    const id = `run-${String(++this.seq)}`;
    const row: WorkflowRun = {
      origin: data.origin ?? null,
      id,
      workflow_name: data.workflow_name,
      conversation_id: data.origin?.conversationId ?? null,
      parent_conversation_id: data.origin?.parentConversationId ?? null,
      codebase_id: data.codebase_id ?? null,
      status: 'pending',
      outcome: null,
      user_message: data.user_message,
      metadata: data.metadata ?? {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: new Date(),
      working_path: data.working_path ?? null,
      user_id: data.origin?.userId ?? null,
      parent_run_id: data.parent_run_id ?? null,
      output_root: null,
      checkout_baseline: null,
      adopted_from_run_id: null,
    };
    this.runs.set(id, row);
    return Promise.resolve(this.clone(row));
  };

  claimPendingWorkflowRun: IWorkflowStore['claimPendingWorkflowRun'] = (id, workingPath) => {
    const row = this.runs.get(id);
    if (!row || row.status !== 'pending') return Promise.resolve(null);
    row.status = 'running';
    row.working_path ??= workingPath ?? null;
    return Promise.resolve(this.clone(row));
  };

  recordWorkflowRunCheckoutBaseline: IWorkflowStore['recordWorkflowRunCheckoutBaseline'] = (
    id,
    baseline
  ) => {
    const row = this.runs.get(id);
    if (!row) return Promise.reject(new Error(`run ${id} not found`));
    row.checkout_baseline ??= baseline;
    return Promise.resolve(row.checkout_baseline);
  };

  getWorkflowRun = (id: string): Promise<WorkflowRun | null> => {
    const r = this.runs.get(id);
    return Promise.resolve(r ? this.clone(r) : null);
  };

  getWorkflowRunsByIds = (ids: readonly string[]): Promise<WorkflowRun[]> =>
    Promise.resolve(
      [...new Set(ids)].flatMap(id => {
        const r = this.runs.get(id);
        return r ? [this.clone(r)] : [];
      })
    );

  getWorkflowRunForAttention = (id: string) => this.getWorkflowRun(id);

  findChildRuns = (parentRunId: string): Promise<WorkflowRun[]> =>
    Promise.resolve(
      [...this.runs.values()].filter(r => r.parent_run_id === parentRunId).map(r => this.clone(r))
    );

  getRunAncestry = (runId: string): Promise<WorkflowRun[]> => {
    const out: WorkflowRun[] = [];
    const seen = new Set([runId]);
    let cur = this.runs.get(runId);
    while (cur?.parent_run_id && !seen.has(cur.parent_run_id)) {
      const parent = this.runs.get(cur.parent_run_id);
      if (!parent) break;
      out.push(this.clone(parent));
      seen.add(parent.id);
      cur = parent;
    }
    return Promise.resolve(out);
  };

  // Prototype method (not an arrow-field) so store doubles can call it via `super`.
  getActiveWorkflowRunByPath(
    workingPath: string,
    self?: { id: string; startedAt: Date; excludeRunIds?: string[] }
  ): Promise<WorkflowRun | null> {
    const exclude = new Set([self?.id, ...(self?.excludeRunIds ?? [])].filter(Boolean));
    const active = [...this.runs.values()]
      .filter(r => r.working_path === workingPath && holdsPathLock(r.status) && !exclude.has(r.id))
      .sort((a, b) => a.started_at.getTime() - b.started_at.getTime());
    return Promise.resolve(active[0] ? this.clone(active[0]) : null);
  }

  resumeWorkflowRun = (id: string): Promise<WorkflowRun> => {
    const r = this.runs.get(id);
    if (!r) throw new Error(`no run ${id}`);
    r.status = 'running';
    return Promise.resolve(this.clone(r));
  };

  recoverCancelledFanOutRun = (id: string): Promise<WorkflowRun> => {
    const r = this.runs.get(id);
    const reason = r?.metadata.cancelled_reason;
    if (!r || r.status !== 'cancelled' || !FAN_OUT_CANCEL_REASONS.some(known => known === reason)) {
      throw new Error(`run ${id} is not recoverable`);
    }
    r.status = 'running';
    r.completed_at = null;
    const { cancelled_reason: _cancelledReason, ...metadata } = r.metadata;
    r.metadata = metadata;
    return Promise.resolve(this.clone(r));
  };

  updateWorkflowRun: IWorkflowStore['updateWorkflowRun'] = (id, updates) => {
    const r = this.runs.get(id);
    if (r) {
      if (updates.status) r.status = updates.status;
      if (updates.outcome) r.outcome = updates.outcome;
      if (updates.metadata) r.metadata = { ...r.metadata, ...updates.metadata };
      // Write-once, mirroring the real store's COALESCE (#2200): a row must report the
      // output location it actually recorded, or a reader that resolves artifacts through
      // it (the artifact-pointer gate, #2453) sees a run that never had one.
      if (updates.output_root && !r.output_root) r.output_root = updates.output_root;
      if (updates.working_path && !r.working_path) r.working_path = updates.working_path;
    }
    return Promise.resolve();
  };

  updateWorkflowRunMetadataIfRunning: IWorkflowStore['updateWorkflowRunMetadataIfRunning'] = async (
    id,
    metadata
  ) => {
    const run = this.runs.get(id);
    if (run?.status !== 'running') return false;
    Object.assign(run.metadata, structuredClone(metadata));
    return true;
  };

  updateWorkflowActivity = (): Promise<void> => Promise.resolve();

  getWorkflowRunStatus = (id: string): Promise<WorkflowRun['status'] | null> =>
    Promise.resolve(this.runs.get(id)?.status ?? null);

  completeWorkflowRun: IWorkflowStore['completeWorkflowRun'] = (id, _completion, metadata) => {
    const r = this.runs.get(id);
    // Mirror the real store's CAS guard (`WHERE status = 'running'`): a run cancelled
    // mid-flight (e.g. a fan-out sibling cooperatively cancelled) must NOT be flipped
    // back to completed when its own execution finishes.
    if (r && r.status === 'running') {
      r.status = 'completed';
      r.completed_at = new Date();
      if (metadata) r.metadata = { ...r.metadata, ...metadata };
    }
    return Promise.resolve();
  };

  failWorkflowRun = (id: string, error: string): Promise<{ failed: boolean }> => {
    const r = this.runs.get(id);
    if (r) {
      r.status = 'failed';
      r.completed_at = new Date();
      r.metadata = { ...r.metadata, error };
    }
    return Promise.resolve({ failed: r !== undefined });
  };

  pauseWorkflowRun: IWorkflowStore['pauseWorkflowRun'] = (
    id,
    approvalContext,
    extraMetadata,
    event
  ) => {
    const r = this.runs.get(id);
    if (!r || r.status !== 'running') {
      return Promise.reject(new WorkflowRunPauseConflictError(id));
    }
    if (r) {
      r.status = 'paused';
      // Mirrors the real store's write ORDER: run-level metadata is folded in first,
      // then `approval` is set wholesale — so nothing from a prior gate survives and
      // the gate context wins over a same-named extra key. Only the order; a JS
      // spread cannot model both dialects' merge depth for `extraMetadata`.
      r.metadata = {
        ...r.metadata,
        ...(extraMetadata ?? {}),
        approval: { ...approvalContext },
      };
    }
    if (event) this.events.push(event);
    return Promise.resolve();
  };

  pauseWorkflowRunForWait: IWorkflowStore['pauseWorkflowRunForWait'] = (id, waitContext) => {
    const r = this.runs.get(id);
    if (r) {
      r.status = 'paused';
      r.metadata = { ...r.metadata, wait: { ...waitContext } };
    }
    return Promise.resolve();
  };

  clearWorkflowWaitContext: IWorkflowStore['clearWorkflowWaitContext'] = (
    id,
    waitContext,
    completion
  ) => {
    const r = this.runs.get(id);
    const wait = r?.metadata.wait as WorkflowWaitContext | undefined;
    const cursorMatches =
      wait?.kind === 'attention' && waitContext.kind === 'attention'
        ? wait.waitingSince === waitContext.waitingSince
        : wait?.kind !== 'attention' &&
          waitContext.kind !== 'attention' &&
          wait?.resumeAt === waitContext.resumeAt;
    if (r?.status === 'running' && wait?.nodeId === waitContext.nodeId && cursorMatches) {
      const { wait: _wait, ...metadata } = r.metadata;
      r.metadata = metadata;
      // Mirror the real store: both rows land in the same transaction as the cursor
      // clear, and the node row is handed back so the caller derives its sinks from it.
      const rows = waitCompletionEvents(id, completion);
      this.events.push(rows.outcome, rows.node);
      return Promise.resolve({ cleared: true, nodeEvent: rows.node });
    }
    return Promise.resolve({ cleared: false });
  };

  claimWriteback = (): Promise<{ claimed: boolean }> => Promise.resolve({ claimed: true });
  releaseWritebackClaim = (): Promise<void> => Promise.resolve();

  // Both cancels write their terminal event in the same step, as the SQL transitions do.
  cancelWorkflowRun: IWorkflowStore['cancelWorkflowRun'] = (id, event) => {
    const r = this.runs.get(id);
    if (r && r.status !== 'completed' && r.status !== 'cancelled') {
      r.status = 'cancelled';
      r.completed_at = new Date();
      const { step_name, ...data } = event ?? {};
      this.events.push({ workflow_run_id: id, event_type: 'workflow_cancelled', step_name, data });
      return Promise.resolve({ cancelled: true });
    }
    return Promise.resolve({ cancelled: false });
  };

  cancelFanOutRun: IWorkflowStore['cancelFanOutRun'] = (id, reason) => {
    const r = this.runs.get(id);
    if (r && r.status !== 'completed' && r.status !== 'cancelled') {
      r.status = 'cancelled';
      r.completed_at = new Date();
      r.metadata = { ...r.metadata, cancelled_reason: reason };
      this.events.push({
        workflow_run_id: id,
        event_type: 'workflow_cancelled',
        data: { reason, cancel_reason: 'fan_out' },
      });
      return Promise.resolve({ cancelled: true });
    }
    return Promise.resolve({ cancelled: false });
  };

  private recordWorkflowEvent: IWorkflowStore['persistWorkflowEvent'] = data => {
    this.events.push(data);
    return Promise.resolve();
  };

  setToolCallAttention: IWorkflowStore['setToolCallAttention'] = async () => true;

  createWorkflowEvent: IWorkflowStore['createWorkflowEvent'] = data =>
    this.recordWorkflowEvent(data);

  persistWorkflowEvent: IWorkflowStore['persistWorkflowEvent'] = data =>
    this.recordWorkflowEvent(data);

  persistWorkflowEventIfRunning: IWorkflowStore['persistWorkflowEventIfRunning'] = data => {
    const run = this.runs.get(data.workflow_run_id);
    if (run?.status !== 'running') return Promise.resolve({ persisted: false });
    this.events.push(data);
    return Promise.resolve({ persisted: true });
  };

  listProviderEvents: IWorkflowStore['listProviderEvents'] = () => Promise.resolve([]);

  getDagResumeSnapshot: IWorkflowStore['getDagResumeSnapshot'] = workflowRunId =>
    foldDagResumeSnapshot(
      this.events.filter(event => event.workflow_run_id === workflowRunId),
      workflowRunId
    );

  getCodebase = (): Promise<null> => Promise.resolve(null);
  getCodebaseEnvVars = (): Promise<Record<string, string>> => Promise.resolve({});
  listWorkflowNodeSessions: IWorkflowStore['listWorkflowNodeSessions'] = () => Promise.resolve([]);
  listWorkflowRunNodeSessions: IWorkflowStore['listWorkflowRunNodeSessions'] = () =>
    Promise.resolve([]);
  upsertWorkflowRunNodeSession: IWorkflowStore['upsertWorkflowRunNodeSession'] = () =>
    Promise.resolve();
  upsertWorkflowNodeSession = (): Promise<void> => Promise.resolve();
  findResumableRun = (): Promise<null> => Promise.resolve(null);

  // --- test helpers ---
  /** Mimic approveWorkflow for a standard approval gate: write node_completed for
   *  the gate node + stamp approval.resolved='approved'. */
  approveGate(runId: string): void {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`no run ${runId}`);
    const approval = r.metadata.approval as Record<string, unknown> | undefined;
    const nodeId = approval?.nodeId as string;
    this.events.push({
      workflow_run_id: runId,
      event_type: 'node_completed',
      step_name: nodeId,
      data: { node_output: '', approval_decision: 'approved' },
    });
    r.metadata = { ...r.metadata, approval: { ...(approval ?? {}), resolved: 'approved' } };
  }
}
