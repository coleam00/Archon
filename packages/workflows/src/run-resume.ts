import { createLogger } from '@archon/paths';
import type { PriorRunUsage } from './dag-executor';
import type { WorkflowDeps } from './deps';
import type { WorkflowRun, WorkflowRunNodeSession } from './schemas';
import {
  isApprovalContext,
  isScheduledWorkflowResume,
  isWorkflowWaitContext,
  readSourceRelease,
  reRunsOwnNodeOnResume,
} from './schemas';
import type { PersistedNodeOutput, WorkflowResumeCursor } from './store';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

export interface ResumableRunInspection {
  priorCompletedNodes: Map<string, PersistedNodeOutput>;
  priorUsage: PriorRunUsage;
}

/** The store reads and the one transition resume preparation needs. */
export interface ResumeStoreDeps {
  store: Pick<
    WorkflowDeps['store'],
    'getDagResumeSnapshot' | 'listWorkflowRunNodeSessions' | 'resumeWorkflowRun'
  >;
}

/** Read whether a candidate has state worth resuming without claiming or mutating it. */
export async function inspectResumableRun(
  deps: ResumeStoreDeps,
  candidate: WorkflowRun
): Promise<ResumableRunInspection | null> {
  const snapshot = await deps.store.getDagResumeSnapshot(candidate.id);
  const priorCompletedNodes = snapshot.completedNodeOutputs;
  const rawApproval = candidate.metadata?.approval;
  const approvalContext = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const hasReRunGateState = reRunsOwnNodeOnResume(approvalContext, candidate.metadata);
  const hasWaitState = isWorkflowWaitContext(candidate.metadata?.wait);
  const hasScheduledResume = isScheduledWorkflowResume(candidate.metadata?.scheduled_resume);
  // Released before its first node could read source (#4209): nothing completed yet.
  const hasSourceRelease =
    candidate.status === 'paused' && readSourceRelease(candidate.metadata) !== undefined;
  // A valid composed instance start is always preceded by its durable fan-out plan.
  // Do not treat an arbitrary unresolved node_started row as resumable: ordinary nodes
  // have no ambiguity guard and replaying one could duplicate its side effects.
  const hasFanOutRecoveryState =
    snapshot.fanOutSnapshots.size > 0 ||
    [...(snapshot.unfinishedInvocations?.values() ?? [])].some(
      execution =>
        execution.node.kind === 'workflow' &&
        execution.node.fanOut === true &&
        execution.lifecycle.status === 'failed'
    );
  if (
    priorCompletedNodes.size === 0 &&
    !hasReRunGateState &&
    !hasWaitState &&
    !hasScheduledResume &&
    !hasSourceRelease &&
    !hasFanOutRecoveryState
  ) {
    getLog().info(
      { resumableRunId: candidate.id },
      'workflow.dag_resume_skipped_no_completed_nodes'
    );
    return null;
  }
  return {
    priorCompletedNodes,
    priorUsage: {
      ...(snapshot.tokens !== undefined ? { tokens: snapshot.tokens } : {}),
      ...(snapshot.tokensUnknown ? { tokensUnknown: true } : {}),
      costUsd: snapshot.costUsd,
    },
  };
}

/**
 * Hydrate an already-located resumable `WorkflowRun` candidate into the form
 * `executeWorkflow` expects. Returns `null` when the candidate has no
 * completed nodes, durable fan-out recovery state, or resumable gate/wait state.
 *
 * The return shape is spread-compatible with `ExecuteWorkflowOptions`
 * so callers can write `executeWorkflow(..., { ...hydrated, codebaseId })`.
 *
 * Throws on database errors; callers decide whether to surface or fall
 * through. The executor itself never performs this lookup — silent fallback
 * inside the executor was the cross-invocation auto-resume bug, so it stays
 * at the call site.
 */
export async function hydrateResumableRun(
  deps: ResumeStoreDeps,
  candidate: WorkflowRun,
  cursor?: WorkflowResumeCursor
): Promise<{
  preCreatedRun: WorkflowRun;
  priorCompletedNodes: Map<string, PersistedNodeOutput>;
  priorUsage: PriorRunUsage;
  priorNodeSessions: WorkflowRunNodeSession[];
} | null> {
  const inspection = await inspectResumableRun(deps, candidate);
  if (inspection === null) return null;
  const { priorCompletedNodes, priorUsage } = inspection;
  // A gate whose node deliberately writes NO node_completed on pause must still be
  // resumable with zero completed nodes: interactive loops, a `workflow:` node
  // blocked on a child (#2121 Phase 2) whose child is the very first node, and a
  // legacy on_reject gate with a genuinely staged rework (#2714) — see
  // reRunsOwnNodeOnResume's doc for the exhaustive per-reason breakdown. A
  // new-mode gate (#2707 step 1) needs no carve-out here: both approve and
  // reject write node_completed immediately.
  const completedNodeIds = new Set(priorCompletedNodes.keys());
  const priorNodeSessions = (await deps.store.listWorkflowRunNodeSessions(candidate.id)).filter(
    row => completedNodeIds.has(row.node_id)
  );
  const preCreatedRun =
    cursor === undefined
      ? await deps.store.resumeWorkflowRun(candidate.id)
      : await deps.store.resumeWorkflowRun(candidate.id, cursor);
  getLog().info(
    { workflowRunId: preCreatedRun.id, priorCompletedCount: priorCompletedNodes.size },
    'workflow.dag_resuming'
  );
  return {
    preCreatedRun,
    priorCompletedNodes,
    priorUsage,
    priorNodeSessions,
  };
}
