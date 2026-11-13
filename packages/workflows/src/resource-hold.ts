/**
 * A run of a workflow that declares `resource:` takes a slot on it before it is claimed,
 * however the run was started.
 */
import { createLogger } from '@archon/paths';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { safeSendMessage, sendCriticalMessage } from './platform-messages';
import type { ResourceBlocker } from './resource-start-store';
import type { ResolvedWorkflow, WorkflowExecutionResult, WorkflowRun } from './schemas';
import {
  ADMISSION_CHECKOUT_GUARD_METADATA_KEY,
  DEFAULT_RESOURCE_CAPACITY,
  type PreparedWorkflowLaunch,
} from './schemas/resource-start';
import { requireTerminalStatusWrite } from './terminal-status-write';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  return (cachedLog ??= createLogger('workflow.resource-hold'));
}

/** How often a start waiting for its workflow's resource asks for a slot again. */
const RESOURCE_WAIT_POLL_MS = 1000;

/**
 * Whether an ancestor of this sub-run holds a slot on `resource`. The sub-run then runs
 * inside that slot: taking a second one would deadlock at capacity 1.
 */
async function ancestorHoldsResource(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  resource: string
): Promise<boolean> {
  if (!workflowRun.parent_run_id) return false;
  for (const ancestor of await deps.store.getRunAncestry(workflowRun.id)) {
    const request = await deps.store.getResourceStartRequest(ancestor.id);
    if (request?.status === 'admitted' && request.resource === resource) return true;
  }
  return false;
}

/**
 * Take a slot on the workflow's `resource:` before the run is claimed, waiting while the
 * resource is full, or refusing when `noWait` is set. A run a binding admitted already
 * holds its workflow's resource, so it takes no second slot.
 */
export async function holdWorkflowResource(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  noWait: boolean
): Promise<WorkflowExecutionResult | undefined> {
  if (workflow.resource === undefined) return undefined;
  const { name: resource, capacity = DEFAULT_RESOURCE_CAPACITY } = workflow.resource;
  if (await ancestorHoldsResource(deps, workflowRun, resource)) return undefined;
  const refuse = async (error: string): Promise<WorkflowExecutionResult> => {
    await sendCriticalMessage(platform, conversationId, `❌ **Workflow not started**: ${error}`);
    await requireTerminalStatusWrite(
      deps.store.cancelWorkflowRun(workflowRun.id, { cancel_reason: 'precondition_failed' }),
      { workflowRunId: workflowRun.id, site: 'workflow.resource_refused' }
    );
    return { success: false, workflowRunId: workflowRun.id, error };
  };
  if (!workflowRun.codebase_id) {
    return refuse(
      `Workflow '${workflow.name}' holds resource '${resource}', and a run takes a slot only in a registered project.`
    );
  }
  const launch: PreparedWorkflowLaunch = {
    version: 2,
    run: {
      id: workflowRun.id,
      workflow_name: workflow.name,
      codebase_id: workflowRun.codebase_id,
      user_message: '',
      metadata: { [ADMISSION_CHECKOUT_GUARD_METADATA_KEY]: workflow.mutates_checkout !== false },
      working_path: cwd,
    },
    execution: { cwd, conversationId, isolation: { kind: 'in-place' } },
  };
  let announced = false;
  for (;;) {
    let blocker: ResourceBlocker | null;
    try {
      blocker = await deps.store.admitPendingRun({ resource, capacity, launch });
    } catch (error) {
      return endResourceWait(deps, workflowRun, resource, error, refuse);
    }
    if (!blocker) return undefined;
    const held = `${blocker.kind === 'run' ? 'held by run' : 'behind queued start'} ${blocker.id}`;
    if (noWait) return refuse(`Resource '${resource}' is full (${held}); the start does not wait.`);
    if (!announced) {
      announced = true;
      getLog().info({ workflowRunId: workflowRun.id, resource, blocker }, 'workflow.resource_wait');
      await safeSendMessage(
        platform,
        conversationId,
        `⏳ Waiting for resource '${resource}' (${held}). The run starts when a slot frees.`
      );
    }
    await Bun.sleep(RESOURCE_WAIT_POLL_MS);
  }
}

/**
 * Admission threw while the start waited. A run that is no longer pending was stopped by
 * someone else (an operator's cancel), so the wait ends quietly; any other failure
 * refuses the start, so the pending row does not outlive this process.
 */
async function endResourceWait(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  resource: string,
  error: unknown,
  refuse: (error: string) => Promise<WorkflowExecutionResult>
): Promise<WorkflowExecutionResult> {
  const current = await deps.store.getWorkflowRun(workflowRun.id);
  if (current?.status !== 'pending') {
    return {
      success: false,
      workflowRunId: workflowRun.id,
      error: `Run stopped while waiting for resource '${resource}' (${current?.status ?? 'missing'}).`,
    };
  }
  getLog().error(
    { err: error, workflowRunId: workflowRun.id, resource },
    'workflow.resource_admission_failed'
  );
  const reason = error instanceof Error ? error.message : String(error);
  return refuse(`Resource '${resource}' admission failed: ${reason}`);
}
