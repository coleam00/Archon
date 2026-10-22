/** Re-entering a run paused on its sub-runs once they release it, and returning a paused run's slot. */
import { createLogger } from '@archon/paths';
import { isWorkflowExecutionInterruption } from './execution-interruption';
import type { ChildIsolationResolver } from './child-isolation';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { spellWorkflowCommand } from './deps';
import { executeWorkflow, type ExecuteWorkflowOptions } from './executor';
import { WorkflowExecutionHandoffError } from './engine-port';
import { safeSendMessage } from './platform-messages';
import { resolveWorkflowName } from './router';
import { hydrateResumableRun } from './run-resume';
import { resolveContinuationWorkflow } from './run-source';
import type {
  ResolvedWorkflow,
  WorkflowExecutionResult,
  WorkflowRun,
  WorkflowRunStatus,
} from './schemas';
import { isApprovalContext, isFanOutBlockReleased, isRunBlockedOnChild } from './schemas';
import { continuablePauseCursor } from './store';
import { requireTerminalStatusWrite } from './terminal-status-write';
import { discoverWorkflowsWithConfig } from './workflow-discovery';

/** Lazy-initialized logger, under the executor name these events have always carried. */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

/**
 * After a `workflow:` sub-run reaches a terminal state, re-enter its PARENT run if
 * the parent is paused blocked on THIS child (#2121 Phase 2). This is the D5 hook
 * that turns a child's completion into a parent resume — the cross-run analogue of
 * a human approve, driven in the same process.
 *
 * No-op (guarded) when:
 *  - the parent is not 'paused' (synchronous first-run path: the parent is still
 *    'running' on the call stack — output threads directly from the returned outcome),
 *  - the parent's gate isn't a `child_workflow` or `fan_out` gate,
 *  - a DIFFERENT child of the same parent terminated (childRunId mismatch), or
 *  - the parent is a fan-out still waiting on other children (`isFanOutBlockReleased`).
 *
 * Failures before the parent resumes leave the child result intact. Once the parent
 * has resumed, lifecycle interruptions propagate because the child cannot report an
 * ordinary result while the parent lifecycle remains unresolved.
 *
 * `resolveChildIsolation` is a plain parameter rather than part of the resume state:
 * `executeWorkflow`'s resume state carries what was RECORDED about the prior run, and a resolver
 * is a live capability of the surface driving this process — it cannot be rehydrated
 * from a run row. It has to be forwarded because the parent picks up here *mid-DAG*:
 * a parent whose gated child just finished may still have `isolation: 'worktree'`
 * nodes ahead of it, and re-entering without the resolver fails them with
 * "requires an injected child-isolation resolver" even though the surface wired one.
 * The child's resolver is the right one to pass: a child inherits the parent's
 * `codebase_id`, and the resolver is codebase-bound and rejects a mismatch loudly.
 */
export async function maybeResumeParentRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  childRun: WorkflowRun,
  resolveChildIsolation?: ChildIsolationResolver
): Promise<void> {
  const parentRunId = childRun.parent_run_id;
  if (!parentRunId) return;

  // Surface a reconciliation failure to the user with a manual-recovery pointer
  // (per the repo's surface-ambiguous-state principle): the child terminated but the
  // parent stayed paused, so a log-only return leaves a stale "blocked on sub-run"
  // gate with no signal. Guarded (safeSendMessage never throws) so it honors the
  // never-throws contract. Only called once we've confirmed the parent IS blocked on
  // THIS child — never for the synchronous no-op or a different-child terminal.
  const notifyStuck = async (reason: string): Promise<void> => {
    await safeSendMessage(
      platform,
      conversationId,
      `⚠️ Sub-run \`${childRun.id.slice(0, 8)}\` finished, but its parent run ` +
        `\`${parentRunId.slice(0, 8)}\` couldn't auto-resume (${reason}). ` +
        `Resume it manually: \`${spellWorkflowCommand(platform, `resume ${parentRunId}`)}\``
    );
  };

  let parent: WorkflowRun | null;
  try {
    parent = await deps.store.getWorkflowRun(parentRunId);
  } catch (err) {
    getLog().error(
      { err: err as Error, parentRunId, childRunId: childRun.id },
      'workflow.parent_resume_lookup_failed'
    );
    await notifyStuck('the parent run could not be looked up');
    return;
  }
  if (parent?.status !== 'paused') return; // synchronous no-op, or already resumed

  // The core "parent blocked on THIS child" invariant lives in one shared predicate
  // (isRunBlockedOnChild) so this hook and the abandon-strand detector can't drift.
  if (!isRunBlockedOnChild(parent, childRun.id)) {
    // Paused but not blocked on this child. Distinguish a MALFORMED child_workflow
    // gate (missing childRunId — an invariant violation that would wedge the parent
    // forever; make it loud) from a normal different-child / non-child gate (silent).
    const approval = isApprovalContext(parent.metadata?.approval)
      ? parent.metadata.approval
      : undefined;
    if (approval?.type === 'child_workflow' && !approval.childRunId) {
      getLog().error(
        { parentRunId, childRunId: childRun.id },
        'workflow.parent_resume_malformed_gate_missing_child_run_id'
      );
    }
    return;
  }

  // A fan-out parent waits on several children. Continuing it on every child's finish
  // would only re-pause it and send another "waiting" notice.
  try {
    if (!(await isFanOutParentReleased(deps, parent))) {
      getLog().info(
        { parentRunId, childRunId: childRun.id },
        'workflow.parent_resume_waiting_on_children'
      );
      return;
    }
  } catch (err) {
    getLog().error(
      { err: err as Error, parentRunId, childRunId: childRun.id },
      'workflow.parent_resume_children_lookup_failed'
    );
    await notifyStuck("the parent's sub-runs could not be looked up");
    return;
  }

  await continueBlockedRun(
    deps,
    platform,
    conversationId,
    parent,
    notifyStuck,
    { childRunId: childRun.id, childStatus: childRun.status },
    resolveChildIsolation
  );
}

/**
 * True unless `run` is paused on a `fan_out` gate whose children have not released it
 * (`isFanOutBlockReleased`). Every other gate is released by its single child.
 */
export async function isFanOutParentReleased(
  deps: WorkflowDeps,
  run: WorkflowRun
): Promise<boolean> {
  const approval = run.metadata?.approval;
  if (!isApprovalContext(approval) || approval.type !== 'fan_out') return true;
  const statusById = new Map(
    (await deps.store.findChildRuns(run.id)).map(child => [child.id, child.status])
  );
  return isFanOutBlockReleased(approval, id => statusById.get(id));
}

/**
 * Continue a paused run whose blocking child (or children) released it: resolve its
 * workflow from the source it started with, claim the resume, and execute it. Returns
 * the execution result, or undefined when it stood down (the run stays paused and
 * resumable, and `notifyStuck` has told the user, unless another resume won the claim).
 * `trigger` is log context only.
 */
export async function continueBlockedRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  parent: WorkflowRun,
  notifyStuck: (reason: string) => Promise<void>,
  trigger: { childRunId?: string; childStatus?: WorkflowRunStatus },
  resolveChildIsolation?: ChildIsolationResolver,
  onExecutionClaimed?: ExecuteWorkflowOptions['onExecutionClaimed']
): Promise<WorkflowExecutionResult | undefined> {
  const parentRunId = parent.id;
  const parentCwd = parent.working_path;
  if (!parentCwd) {
    getLog().warn(
      { parentRunId, childRunId: trigger.childRunId },
      'workflow.parent_resume_no_working_path'
    );
    await notifyStuck('the parent has no recorded working path');
    return undefined;
  }

  let parentWorkflow: ResolvedWorkflow | undefined;
  try {
    parentWorkflow = await resolveParentResumeWorkflow(deps, parent, parentCwd);
  } catch (err) {
    getLog().error({ err: err as Error, parentRunId }, 'workflow.parent_resume_discovery_failed');
    await notifyStuck('workflow discovery failed');
    return undefined;
  }
  if (!parentWorkflow) {
    getLog().warn(
      { parentRunId, workflowName: parent.workflow_name },
      'workflow.parent_resume_workflow_not_found'
    );
    await notifyStuck(`the parent workflow '${parent.workflow_name}' could not be found`);
    return undefined;
  }

  let hydrated: Awaited<ReturnType<typeof hydrateResumableRun>>;
  try {
    hydrated = await hydrateResumableRun(deps, parent);
  } catch (err) {
    // Nothing has been mutated yet on a pre-CAS throw (resumeWorkflowRun's CAS is
    // hydrate's last step; a lost CAS throws WorkflowNotResumableError instead) —
    // the parent stays 'paused' and manually resumable, so log and stand down.
    if (err instanceof Error && err.name === 'WorkflowNotResumableError') {
      // Benign race: a concurrent (manual or duplicate) resume won the CAS and
      // now owns the parent. Not an error — no user-facing message (it IS resuming).
      getLog().info(
        { parentRunId, childRunId: trigger.childRunId },
        'workflow.parent_auto_resume_lost_race'
      );
    } else {
      getLog().error({ err: err as Error, parentRunId }, 'workflow.parent_resume_hydrate_failed');
      await notifyStuck('preparing the parent for resume failed');
    }
    return undefined;
  }
  if (!hydrated) {
    // A parent paused on a child_workflow or fan_out gate is always resumable (see
    // reRunsOwnNodeOnResume), so null here is unexpected.
    getLog().warn({ parentRunId }, 'workflow.parent_resume_nothing_to_resume');
    await notifyStuck('the parent had no resumable state');
    return undefined;
  }

  getLog().info(
    { parentRunId, childRunId: trigger.childRunId, childStatus: trigger.childStatus },
    'workflow.parent_auto_resume_started'
  );
  try {
    return await executeWorkflow(
      deps,
      platform,
      conversationId,
      parentCwd,
      parentWorkflow,
      parent.user_message ?? '',
      parent.origin ?? undefined,
      {
        ...hydrated,
        onExecutionClaimed,
        codebaseId: parent.codebase_id ?? undefined,
        resolveChildIsolation,
      }
    );
  } catch (err) {
    if (isWorkflowExecutionInterruption(err) || err instanceof WorkflowExecutionHandoffError)
      throw err;

    // The hydrate CAS above already flipped the parent paused→running, and
    // executeWorkflow's own failWorkflowRun catch-all doesn't cover its early
    // setup (config load, env/credential resolution). Without this handler a
    // throw there would strand the parent at 'running' — a non-terminal status
    // resumeWorkflow refuses, leaving destructive abandon as the only exit.
    // Land it in 'failed' instead so it stays resumable.
    getLog().error(
      { err: err as Error, parentRunId, childRunId: trigger.childRunId },
      'workflow.parent_auto_resume_execute_failed'
    );
    const error = `Auto-resume after sub-run failed: ${(err as Error).message}`;
    await requireTerminalStatusWrite(deps.store.failWorkflowRun(parentRunId, error), {
      workflowRunId: parentRunId,
      site: 'workflow.parent_auto_resume_fail_mark_failed',
    });
    return { success: false, workflowRunId: parentRunId, error };
  }
}

async function resolveParentResumeWorkflow(
  deps: WorkflowDeps,
  parent: WorkflowRun,
  cwd: string
): Promise<ResolvedWorkflow | undefined> {
  const continuation = await resolveContinuationWorkflow(deps, parent, cwd);
  if (continuation) return continuation.workflow;
  // Only runs predating source capture may resolve from the live checkout.
  const { workflows } = await discoverWorkflowsWithConfig(cwd, deps.loadConfig, deps.providers);
  return resolveWorkflowName(
    parent.workflow_name,
    workflows.map(entry => entry.workflow)
  );
}

/**
 * A run that stopped executing while paused where the continuation host continues it gives
 * back its resource slot (`releasePausedRunSlot`); its continuation takes one again. Called
 * only once every node of this execution has settled, so nothing of the run still runs.
 */
export async function releaseContinuablePauseSlot(
  deps: WorkflowDeps,
  run: WorkflowRun
): Promise<void> {
  const cursor = continuablePauseCursor(run);
  if (!cursor) return;
  try {
    await deps.store.releasePausedRunSlot(run.id, cursor);
  } catch (err) {
    // Holding the slot is the safe direction: the run stays paused and correct, and its
    // resume takes the slot it still holds.
    getLog().warn(
      { err: err as Error, workflowRunId: run.id },
      'workflow.paused_slot_release_failed'
    );
  }
}
