import { createLogger } from '@archon/paths';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { IIsolationStore } from '@archon/isolation';
import type { UserRole } from '../../schemas/user';
import {
  authorizeRunAction,
  RunActionForbiddenError,
  type RunActor,
  type RunAction,
} from '../run-authorization';
import type { requestDetachedRunStop } from '../../services/run-owner-stop';
import type { isRunOwnedByThisProcess, isRunOwnerAnswering } from '../../services/run-live-owner';
import type { reclaimRunWorktree as ReclaimRunWorktree } from '../../services/cleanup/run-worktree';

// Lazy logger — NEVER at module scope
let cachedLog: ReturnType<typeof createLogger> | undefined;
export function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('operations');
  return cachedLog;
}

export interface RunActionStore {
  deleteWorkflowRun: (id: string) => Promise<void>;
}

export interface WorkflowOperationsDeps {
  getUserRole: (userId: string) => Promise<UserRole | undefined>;
  store: Pick<
    IWorkflowStore,
    | 'getWorkflowRun'
    | 'findChildRuns'
    | 'getRunAncestry'
    | 'persistWorkflowEvent'
    | 'cancelWorkflowRun'
    | 'resolveApprovalGate'
    | 'resolveAndCancelApprovalGate'
    | 'answerAttentionWait'
    | 'labelAttentionWait'
    | 'cancelResumableRunsForConversation'
    | 'deleteWorkflowNodeSessions'
    | 'listWorkflowRuns'
    | 'findWorkflowRunsByIdPrefix'
    | 'signalWorkflowWait'
  > &
    RunActionStore;
  hostStore: { isolation: IIsolationStore };
  requestDetachedRunStop: typeof requestDetachedRunStop;
  isRunOwnedByThisProcess: typeof isRunOwnedByThisProcess;
  isRunOwnerAnswering: typeof isRunOwnerAnswering;
  reclaimContainerEnv: (envId: string, store: IIsolationStore) => Promise<void>;
  reclaimRunWorktree: typeof ReclaimRunWorktree;
}

/** The supplied effects plus the lookup and authorization every operation starts with. */
export interface OperationContext extends WorkflowOperationsDeps {
  assertAuthorized: (
    run: WorkflowRun,
    actor: RunActor,
    action: RunAction,
    role: UserRole | undefined
  ) => void;
  assertMayAct: (run: WorkflowRun, actor: RunActor, action: RunAction) => Promise<void>;
  getRunOrThrow: (runId: string, logEvent: string) => Promise<WorkflowRun>;
}

export function createOperationContext(deps: WorkflowOperationsDeps): OperationContext {
  function assertAuthorized(
    run: WorkflowRun,
    actor: RunActor,
    action: RunAction,
    role: UserRole | undefined
  ): void {
    if (authorizeRunAction(actor, run.user_id, role)) return;
    getLog().warn(
      { runId: run.id, actorKind: actor.kind, action },
      'operations.run_action_forbidden'
    );
    throw new RunActionForbiddenError(action, run.user_id);
  }

  async function assertMayAct(run: WorkflowRun, actor: RunActor, action: RunAction): Promise<void> {
    const role = actor.kind === 'user' ? await deps.getUserRole(actor.userId) : undefined;
    assertAuthorized(run, actor, action, role);
  }

  async function getRunOrThrow(runId: string, logEvent: string): Promise<WorkflowRun> {
    let run: WorkflowRun | null;
    try {
      run = await deps.store.getWorkflowRun(runId);
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, errorType: err.constructor.name, runId }, logEvent);
      throw new Error(`Failed to look up workflow run ${runId}: ${err.message}`);
    }
    if (!run) {
      throw new Error(`Workflow run not found: ${runId}`);
    }
    return run;
  }

  return { ...deps, assertAuthorized, assertMayAct, getRunOrThrow };
}
