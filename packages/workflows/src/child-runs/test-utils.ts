import { providerRegistry } from '@archon/providers';
import type { InMemoryStoreEvent } from '../test-utils';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { settlingProvider } from '../test-settling-provider';
/**
 * Shared scaffolding for the end-to-end `workflow:` sub-run tests (#2121 Phase 2), the
 * `child-runs.*.test.ts` files beside child-runs.ts.
 *
 * Those tests drive the REAL executor recursion — executeWorkflow → runChildWorkflow
 * closure → executeDagWorkflow → executeWorkflowNode → child executeWorkflow — with
 * a stateful in-memory store, a canned AI provider, and real workflow files on disk
 * (so runChildWorkflow's discovery/resolveWorkflowName and the parent auto-resume
 * hook both work against real definitions).
 *
 * Importing this module replaces `@archon/paths`, `@archon/git` and `fs/promises`
 * with test doubles and registers the built-in providers, so it must be the first
 * import of a test file that starts with `// @archon-test-isolated`. Such a file
 * deliberately does NOT mock ./dag-executor, so it cannot share a process with the
 * executor.*.test.ts files, which do (mock.module is process-global and irreversible).
 */
import { readBundleIndex } from '../defaults/bundle-inventory';
import { afterAll, mock } from 'bun:test';
import { mkdir, cp } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { existsSync } from 'fs';
import { dirname, join, sep } from 'path';
import { tmpdir } from 'os';

// --- Mock logger + telemetry (passthrough real path utilities like loader.test.ts) ---
export const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
// Capture-cost control: captureWorkflowSource writes the BUNDLED defaults scope
// (the repo's own .archon/workflows + .archon/commands) into EVERY staged source
// capture, on every executeWorkflow level of every run in this file — e2e timing
// evidence (#2121 Phase 2 CI) shows that uncontrolled per-run fs fan-out is what
// pushed the specimen test past the 5000ms budget Windows CI then had. #2924
// hoisted the READ and the hash of that scope out of the per-capture path, but
// the bytes still have to land in each capture, so the writes remain and so does
// this lever. No test here exercises bundled default CONTENT: every discovery call
// opts out of loading them (`loadDefaults: false`) and every workflow under test is
// written to the tmp cwd. Pointing the two bundle path getters at a dedicated EMPTY
// directory (outside ARCHON_HOME) keeps the capture's bundled-scope semantics (an
// existing-but-empty tree is scanned, recorded in the manifest with 0 files) while
// removing that file fan-out per capture per platform-multiplied runner.
const bundledDefaultsRoot = join(tmpdir(), `subrun-test-empty-bundled-${process.pid}`);
await mkdir(join(bundledDefaultsRoot, 'defaults'), { recursive: true });
for (const pack of await readBundleIndex())
  await mkdir(join(bundledDefaultsRoot, pack), { recursive: true });
afterAll(() => removeTempTree(bundledDefaultsRoot));
export const realArchonPaths = await import('@archon/paths');
/** Every `workflow_invoked` telemetry call, in order, so a resumed drive's categorization
 *  can be compared with the dispatch that started the run. */
export const telemetryInvocations: { workflowName: string; workflowSource?: string }[] = [];
/** Each `workflow_invoked` call's resume flag, kept apart so the categorization records
 *  above stay comparable as whole objects. */
export const telemetryResumeFlags: { workflowName: string; isResume?: boolean }[] = [];
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  // NB: point these one level DEEP (`<root>/defaults`) — captureWorkflowSource copies
  // dirname(getDefault*Path()), so the getter's PARENT must be the owned empty tree.
  getBundledWorkflowsPath: () => bundledDefaultsRoot,
  createLogger: mock(() => mockLogger),
  captureWorkflowInvoked: mock(
    (props: { workflowName: string; workflowSource?: string; isResume?: boolean }) => {
      telemetryInvocations.push({
        workflowName: props.workflowName,
        workflowSource: props.workflowSource,
      });
      telemetryResumeFlags.push({ workflowName: props.workflowName, isResume: props.isResume });
    }
  ),
  captureApprovalResolved: mock(() => undefined),
}));

// --- Mock git (no real repo needed) ---
export const detectDefaultBranch = mock(async () => 'main');
mock.module('@archon/git', () => ({
  getDefaultBranch: detectDefaultBranch,
  getDefaultRemote: mock(async () => 'origin'),
  toRepoPath: mock((p: string) => p),
}));

// --- Filesystem controls keep source removal pending or force the rename the recursive
//     executeWorkflow performs (moving the staged capture under the child's
//     artifacts directory) to throw. The wrap's `finally` is the only thing that
//     can reclaim that staged capture when the rename fails — without the fix
//     in runChildWorkflow, the staged tree leaks until the hourly age-based
//     sweep reaps it (review R1). Removal gates only target existing, finalized
//     roots under the current test staging directory; preparation and other cleanup
//     delegate to the real filesystem.
//
//     The forced failure targets ONLY the move-out-of-staging rename: source
//     lives under `staged-source/`, destination does NOT. `captureWorkflowSource`
//     also does a rename (staged-source/<uuid>.partial -> staged-source/<uuid>)
//     and that one must keep working, otherwise `prepareWorkflowSource` itself
//     throws before runChildWorkflow reaches the recursive call.
//
//     The path predicate uses `path.sep`, not a hardcoded forward slash:
//     `fs/promises.rename` on Windows is called with backslash-separated paths
//     produced by `path.join`, so a literal `'staged-source/'` substring check
//     never matches there and the test fails to exercise the reclaim path it is
//     here to prove. ---
const realFsPromises = await import('fs/promises');
let forceRenameFailure = false;
export function setForceRenameFailure(value: boolean): void {
  forceRenameFailure = value;
}
const passthroughRename = realFsPromises.rename;
const passthroughRemove = realFsPromises.rm;
let removeSource: typeof passthroughRemove | undefined;

export function holdSourceRemoval(
  stagedDir: string,
  removalError?: Error
): {
  started: Promise<string>;
  release: () => void;
  finish: () => Promise<void>;
} {
  let signalStarted!: (root: string) => void;
  let release!: () => void;
  let activeRemoval: Promise<void> = Promise.resolve();
  const started = new Promise<string>(resolve => {
    signalStarted = resolve;
  });
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  removeSource = (path, options) => {
    if (
      typeof path !== 'string' ||
      dirname(path) !== stagedDir ||
      path.endsWith('.partial') ||
      !existsSync(path)
    ) {
      return passthroughRemove(path, options);
    }
    signalStarted(path);
    activeRemoval = released.then(async () => {
      if (removalError) throw removalError;
      await passthroughRemove(path, options);
    });
    return activeRemoval;
  };
  return {
    started,
    release,
    finish: async () => {
      release();
      await activeRemoval.catch(() => undefined);
      removeSource = undefined;
    },
  };
}
const stagedSourcePathSep = `staged-source${sep}`;
mock.module('fs/promises', () => ({
  ...realFsPromises,
  rm: (...args: Parameters<typeof passthroughRemove>): Promise<void> =>
    (removeSource ?? passthroughRemove)(...args),
  rename: async (src: string, dst: string): Promise<void> => {
    if (
      forceRenameFailure &&
      src.includes(stagedSourcePathSep) &&
      !dst.includes(stagedSourcePathSep)
    ) {
      throw new Error(`forced rename failure for test: ${src} -> ${dst}`);
    }
    return passthroughRename(src, dst);
  },
}));

// --- Bootstrap provider registry (load-time isRegisteredProvider checks) ---
import { clearRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
clearRegistry();
registerBuiltinProviders();

import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from '../deps';
import type { IWorkflowStore } from '../store';
import {
  FAN_OUT_CANCEL_REASONS,
  waitCompletionEvents,
  WorkflowRunPauseConflictError,
} from '../store';
import { type WorkflowRun, type WorkflowWaitContext } from '../schemas/workflow-run';
import type { WorkflowRunConfigMetadata } from '../schemas/run-config';
import type {
  ChildIsolationResolver,
  ChildIsolationRequest,
  ChildIsolationResult,
} from '../child-isolation';

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
  listWorkflowEvents: IWorkflowStore['listWorkflowEvents'] = async () => {
    throw new Error('Not used by this test');
  };
  listEventsForRuns: IWorkflowStore['listEventsForRuns'] = async (runIds, eventTypes) => {
    const types = new Set<string>(eventTypes);
    return new Map(
      runIds.map(runId => [
        runId,
        this.events.flatMap((event, index) =>
          event.workflow_run_id === runId && types.has(event.event_type)
            ? [
                {
                  ...event,
                  id: String(index),
                  step_index: null,
                  step_name: event.step_name ?? null,
                  data: event.data ?? {},
                  created_at: new Date(0).toISOString(),
                  event_order: index,
                },
              ]
            : []
        ),
      ])
    );
  };
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

  cancelWorkflowRun = (id: string): Promise<{ cancelled: boolean }> => {
    const r = this.runs.get(id);
    if (r && r.status !== 'completed' && r.status !== 'cancelled') {
      r.status = 'cancelled';
      r.completed_at = new Date();
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

// --- Canned AI provider: every prompt node yields the same output + a small cost ---
export function makeProvider() {
  return {
    getType: () => 'claude',
    getCapabilities: () => ({
      backgroundWork: 'unobserved' as const,
      sessionResume: true,
      mcp: true,
      hooks: true,
      skills: true,
      agents: true,
      toolRestrictions: true,
      structuredOutput: 'enforced' as const,
      envInjection: true,
      costControl: true,
      effortControl: true,
      fallbackModel: true,
      sandbox: true,
    }),
    sendQuery: mock(function* () {
      yield { type: 'agent_message_chunk', text: 'ai-output' };
      yield {
        type: 'result',
        sessionId: 'sess',
        cost: 0.01,
        tokens: { input: 7, output: 3, cacheRead: 5, cacheWrite: 0 },
      };
    }),
  };
}

export function makeDeps(store: IWorkflowStore): WorkflowDeps {
  return {
    providers: providerRegistry,
    store,
    getAgentProvider: mock(() =>
      settlingProvider(makeProvider())
    ) as unknown as WorkflowDeps['getAgentProvider'],
    loadConfig: mock(
      (): Promise<WorkflowConfig> =>
        Promise.resolve({
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          commands: {},
          defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        })
    ),
    sealRunConfig: (layer, source): WorkflowRunConfigMetadata => ({
      version: 1,
      ciphertext: 'opaque-test-payload',
      source,
      keys: [
        ...Object.keys(layer.tiers ?? {}).map(name => `tiers.${name}`),
        ...Object.keys(layer.envVars ?? {}).map(name => `env.${name}`),
      ].sort(),
    }),
  };
}

export function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

/**
 * Fake child-isolation resolver (slice 2, PR-A). Records the requests it receives
 * and returns a fixed per-child cwd, creating it on disk so the child's
 * executeWorkflow (artifacts/logs) has a real directory — a real worktree IS a
 * real checkout.
 */
export function makeFakeResolver(childCwd: string): {
  resolver: ChildIsolationResolver;
  calls: ChildIsolationRequest[];
} {
  const calls: ChildIsolationRequest[] = [];
  const resolver: ChildIsolationResolver = {
    async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
      calls.push(req);
      await mkdir(childCwd, { recursive: true });
      return {
        cwd: childCwd,
        envId: `env-${String(req.childIndex ?? 0)}`,
        baseBranch: 'child-release',
        branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-child-${String(req.childIndex ?? 0)}`,
      };
    },
  };
  return { resolver, calls };
}

/**
 * Fan-out child-isolation resolver (slice 2, PR-C): gives each child a DISTINCT
 * worktree keyed by childIndex (so N concurrent siblings don't collide on the path
 * lock) and copies the repo's `.archon` into it so the child can still discover its
 * own target workflow from the isolated checkout. Records the requests it saw.
 */
export function makeFanResolver(root: string): {
  resolver: ChildIsolationResolver;
  calls: ChildIsolationRequest[];
} {
  const calls: ChildIsolationRequest[] = [];
  const resolver: ChildIsolationResolver = {
    async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
      calls.push(req);
      const idx = req.childIndex ?? 0;
      const dir = join(root, 'wt', `${req.parentRun.id}-child-${String(idx)}`);
      await mkdir(dir, { recursive: true });
      // Copy ONLY the workflows subtree, not all of `.archon`: the child reads no
      // other fixture state out of its isolated checkout (config comes from the
      // mocked loadConfig; artifacts land under ARCHON_HOME). A full-tree cp re-copied
      // every artifact/log directory earlier drives had created into `.archon`,
      // growing per child per drive — exactly the uncontrolled per-child fs cost this
      // resolver exists to keep bounded.
      const workflowsRoot = join(root, '.archon', 'workflows');
      if (existsSync(workflowsRoot)) {
        await mkdir(join(dir, '.archon'), { recursive: true });
        await cp(workflowsRoot, join(dir, '.archon', 'workflows'), { recursive: true });
      }
      return {
        cwd: dir,
        envId: `env-${req.parentRun.id.slice(0, 8)}-${String(idx)}`,
        baseBranch: 'child-release',
        branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-child-${String(idx)}`,
      };
    },
  };
  return { resolver, calls };
}

/** Child that echoes its per-item $ARGUMENTS, so fan-out aggregate ordering + the
 *  item→$ARGUMENTS channel are both observable. Declares no `mutates_checkout`, so it
 *  is treated as a repo-writing child (the default posture). */
export const fanChildEcho = `
name: fan-child
description: echoes its per-item argument
nodes:
  - id: echo
    bash: |
      printf 'did:%s' "$ARGUMENTS"
`;

/** Child that succeeds echoing its arg, but fails (exit 3) on the item "boom". Read-only,
 *  so N of these share the parent checkout without contending for the path lock. */
export const fanChildCond = `
name: fan-child-cond
description: fails on the item "boom", echoes otherwise
mutates_checkout: false
nodes:
  - id: run
    bash: |
      if [ "$ARGUMENTS" = "boom" ]; then exit 3; fi
      printf 'ok:%s' "$ARGUMENTS"
`;
