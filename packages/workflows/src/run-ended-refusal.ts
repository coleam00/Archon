import type { WorkflowDeps } from './deps';
import type { WorkflowRun } from './schemas/workflow-run';
import { requireTerminalStatusWrite } from './terminal-status-write';

/**
 * Refuse a pending run whose end would fire a broken run-ended binding: cancel it as
 * `precondition_failed` while it is still pending, and return why. Undefined when every
 * binding it could fire is sound. A detached launcher calls this on the row it created,
 * before the fork; admission calls it again before the claim.
 */
export async function refuseBrokenRunEndedBindings(
  deps: Pick<WorkflowDeps, 'checkRunEndedBindings' | 'store'>,
  run: WorkflowRun
): Promise<string | undefined> {
  if (!deps.checkRunEndedBindings) return undefined;
  try {
    await deps.checkRunEndedBindings(run);
    return undefined;
  } catch (error) {
    const reason = `Run-ended trigger is invalid: ${(error as Error).message}`;
    await requireTerminalStatusWrite(
      // Before the claim another dispatcher may own this row: cancel it only while pending.
      deps.store.cancelWorkflowRun(
        run.id,
        { cancel_reason: 'precondition_failed' },
        { pendingOnly: true }
      ),
      {
        workflowRunId: run.id,
        site: 'workflow.run_ended_binding_refused',
        failure: new Error(reason),
      }
    );
    return reason;
  }
}
