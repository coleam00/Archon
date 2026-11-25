import { createLogger } from '@archon/paths';
import type { PriorRunUsage } from './dag-executor';
import type { WorkflowDeps } from './deps';
import type { WorkflowRun, WorkflowRunNodeSession } from './schemas';
import { readPauseCause } from './schemas';
import type { PersistedNodeOutput, PriorFailedNode, ResumeClaimCursor } from './store';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

export interface ResumableRunInspection {
  priorCompletedNodes: Map<string, PersistedNodeOutput>;
  priorFailedNodes: Map<string, PriorFailedNode>;
  priorUsage: PriorRunUsage;
}

/**
 * Why a run resumes. `continue_after_wait` continues a run that paused at a node that
 * waits on purpose: an attention, time or event wait, an approval gate, or children it is
 * blocked on; or one an operator paused at a node boundary. The run had moved past any node that failed before that pause, so those
 * failures replay. `retry_failed` covers everything else, where the failures are what
 * stopped the run: a failed run an operator resumes, a provider-limit pause, a released
 * source, or a pause with no recorded cause. Those failed nodes run again, as they always
 * have.
 */
export type ResumeCause = 'continue_after_wait' | 'retry_failed';

/**
 * Read from the resumed row the compare-and-swap returned, so the cause is the one the
 * pause it consumed recorded, never a context an earlier pause left in metadata. Failing
 * a run removes the cause, so a failed run resumed by an operator always retries.
 */
function resumeCauseOf(candidate: WorkflowRun, resumed: WorkflowRun): ResumeCause {
  if (candidate.status !== 'paused') return 'retry_failed';
  const cause = readPauseCause(resumed.metadata);
  return cause === 'wait' || cause === 'gate' || cause === 'child' || cause === 'operator'
    ? 'continue_after_wait'
    : 'retry_failed';
}

/** The store reads and the one transition resume preparation needs. */
export interface ResumeStoreDeps {
  store: Pick<
    WorkflowDeps['store'],
    'getDagResumeSnapshot' | 'listWorkflowRunNodeSessions' | 'resumeWorkflowRun'
  >;
}

/**
 * Read a candidate's resume state without claiming or mutating it. A run with no completed
 * node is still resumable: it runs again from its first node under the same run id.
 */
export async function inspectResumableRun(
  deps: ResumeStoreDeps,
  candidate: WorkflowRun
): Promise<ResumableRunInspection> {
  const snapshot = await deps.store.getDagResumeSnapshot(candidate.id);
  return {
    priorCompletedNodes: snapshot.completedNodeOutputs,
    priorFailedNodes: snapshot.failedNodes,
    priorUsage: snapshot,
  };
}

/**
 * Hydrate an already-located resumable `WorkflowRun` candidate into the form
 * `executeWorkflow` expects, claiming it. Completed nodes are skipped; a run with none
 * runs again from its first node.
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
  cursor?: ResumeClaimCursor
): Promise<{
  preCreatedRun: WorkflowRun;
  priorCompletedNodes: Map<string, PersistedNodeOutput>;
  priorFailedNodes: Map<string, PriorFailedNode>;
  resumeCause: ResumeCause;
  priorUsage: PriorRunUsage;
  priorNodeSessions: WorkflowRunNodeSession[];
}> {
  const inspection = await inspectResumableRun(deps, candidate);
  const { priorCompletedNodes, priorUsage } = inspection;
  // Only completed nodes' sessions carry forward; a node that runs again starts its own.
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
    priorFailedNodes: inspection.priorFailedNodes,
    resumeCause: resumeCauseOf(candidate, preCreatedRun),
    priorUsage,
    priorNodeSessions,
  };
}
