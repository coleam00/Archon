/**
 * A run of a workflow that declares `resource:` takes a slot on it before it is claimed,
 * however the run was started. A hand start waits here for its slot, and at its claim for
 * its item (`waitForTurn`). While the install hold is set, a hand start waits for the lift
 * at whichever of the two comes first.
 */
import { createLogger } from '@archon/paths';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { safeSendMessage, sendCriticalMessage } from './platform-messages';
import type { ResourceBlocker } from './resource-start-store';
import type { ResolvedWorkflow, WorkflowExecutionResult, WorkflowRun } from './schemas';
import {
  ADMISSION_CHECKOUT_GUARD_METADATA_KEY,
  DEFAULT_RESOURCE_CAPACITY,
  describeInstallHold,
  type InstallHold,
  type PreparedWorkflowLaunch,
} from './schemas/resource-start';
import { InstallHeldError } from './store/errors';
import { requireTerminalStatusWrite } from './terminal-status-write';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  return (cachedLog ??= createLogger('workflow.resource-hold'));
}

/** How often a start waiting for its workflow's resource or item asks again. */
const WAIT_POLL_MS = 1000;

/**
 * What holds a waiting start, in words the operator reads: `waiting` follows "Waiting for",
 * `refusal` is the sentence a `--no-wait` start is refused with.
 */
export interface StartHold {
  waiting: string;
  refusal: string;
  log: Record<string, unknown>;
  /** The run holding the start's item, recorded with a refusal. */
  heldBy?: string;
}

/** One try of a waiting start: what holds it, or that its wait is over. */
export type TurnAttempt = { held: StartHold } | { done: WorkflowExecutionResult | undefined };

/** The hold of a start whose item another run of its workflow holds. */
export function itemHold(itemKey: string, holderRunId: string, workflow: string): StartHold {
  const by = `run ${holderRunId} of workflow '${workflow}'`;
  return {
    waiting: `item '${itemKey}' (held by ${by}). The run starts when that run ends.`,
    refusal: `Item '${itemKey}' is held by ${by}; the start does not wait.`,
    log: { itemKey, holderRunId },
    heldBy: holderRunId,
  };
}

/** The hold of a start that the install hold keeps from admission. */
export function installHold(hold: InstallHold): StartHold {
  const by = describeInstallHold(hold);
  return {
    waiting: `the install hold (${by}). The run starts when the hold is lifted.`,
    refusal: `New runs are held on this install (${by}); the start does not wait.`,
    log: { installHoldSetAt: hold.setAt },
  };
}

/**
 * Try `attempt` until its wait is over. The first time it is held, the start says what it
 * waits behind; with `noWait` it is refused at once instead, naming the same thing.
 */
export async function waitForTurn(input: {
  deps: WorkflowDeps;
  platform: IWorkflowPlatform;
  conversationId: string;
  workflowRun: WorkflowRun;
  noWait: boolean;
  attempt: () => Promise<TurnAttempt>;
}): Promise<WorkflowExecutionResult | undefined> {
  const { deps, platform, conversationId, workflowRun } = input;
  let announced = false;
  for (;;) {
    const tried = await input.attempt();
    if ('done' in tried) return tried.done;
    if (input.noWait)
      return refuseStart(
        deps,
        platform,
        conversationId,
        workflowRun,
        tried.held.refusal,
        tried.held.heldBy
      );
    if (!announced) {
      announced = true;
      getLog().info({ workflowRunId: workflowRun.id, ...tried.held.log }, 'workflow.start_wait');
      await safeSendMessage(platform, conversationId, `⏳ Waiting for ${tried.held.waiting}`);
    }
    await Bun.sleep(WAIT_POLL_MS);
  }
}

/**
 * The hold behind `blocker`. A run of the same workflow on the same item holds the item,
 * not a slot: admission checks the item first and reports the holding run either way.
 */
async function resourceHold(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  resource: string,
  blocker: ResourceBlocker
): Promise<StartHold> {
  if (blocker.kind === 'run' && workflowRun.item_id !== null) {
    const holder = await deps.store.getWorkflowRun(blocker.id);
    if (
      holder?.item_id === workflowRun.item_id &&
      holder.workflow_name === workflowRun.workflow_name
    ) {
      const item = await deps.store.getItem(workflowRun.item_id);
      return itemHold(item?.key ?? workflowRun.item_id, blocker.id, holder.workflow_name);
    }
  }
  const held = `${blocker.kind === 'run' ? 'held by run' : 'behind queued start'} ${blocker.id}`;
  return {
    waiting: `resource '${resource}' (${held}). The run starts when a slot frees.`,
    refusal: `Resource '${resource}' is full (${held}); the start does not wait.`,
    log: { resource, blocker },
  };
}

/** Refuse a hand start before its claim: say why and cancel its pending row. */
export async function refuseStart(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  error: string,
  heldBy?: string
): Promise<WorkflowExecutionResult> {
  await sendCriticalMessage(platform, conversationId, `❌ **Workflow not started**: ${error}`);
  await requireTerminalStatusWrite(
    // Unclaimed, the row may be claimed by another dispatcher while the message is sent:
    // cancel it only while it is still pending.
    deps.store.cancelWorkflowRun(
      workflowRun.id,
      {
        cancel_reason: 'precondition_failed',
        ...(heldBy === undefined ? {} : { held_by_run_id: heldBy }),
      },
      { pendingOnly: true }
    ),
    { workflowRunId: workflowRun.id, site: 'workflow.start_refused' }
  );
  return { success: false, workflowRunId: workflowRun.id, error };
}

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
  const refuse = (error: string): Promise<WorkflowExecutionResult> =>
    refuseStart(deps, platform, conversationId, workflowRun, error);
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
  return waitForTurn({
    deps,
    platform,
    conversationId,
    workflowRun,
    noWait,
    attempt: async () => {
      let blocker: ResourceBlocker | null;
      try {
        blocker = await deps.store.admitPendingRun({ resource, capacity, launch });
      } catch (error) {
        if (error instanceof InstallHeldError) return { held: installHold(error.hold) };
        return { done: await endResourceWait(deps, workflowRun, resource, error, refuse) };
      }
      if (!blocker) return { done: undefined };
      return { held: await resourceHold(deps, workflowRun, resource, blocker) };
    },
  });
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
