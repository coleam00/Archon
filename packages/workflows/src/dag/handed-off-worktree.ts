/**
 * Which completed worktree a run's end keeps for the stage it hands it to, instead of
 * releasing it: the run-ended starts this end causes, and the asks-settled start its asks
 * will cause.
 */
import type { WorkflowDeps } from '../deps';
import type { AsksCheckout } from '../schemas/resource-start';
import type { WorktreeDisposition } from '../schemas/terminal-record';
import type { WorkflowRun } from '../schemas/workflow-run';

/**
 * A worktree this end hands to the stage it starts is kept for that stage (`in_use`, which
 * older binaries also read); cleanup then keeps it while the start waits. One its asks will
 * hand on is kept from this release only: if it is gone when they settle, that start is refused.
 */
export function keepHandedOff(
  disposition: WorktreeDisposition | null | undefined,
  workflowRun: WorkflowRun,
  result: Parameters<WorkflowDeps['store']['completeWorkflowRun']>[3],
  asksCheckout: AsksCheckout | undefined
): WorktreeDisposition | null | undefined {
  if (disposition?.disposition !== 'release') return disposition;
  const stage = result?.startReceipts
    ?.flatMap(accepted => accepted.bindings)
    .find(binding => binding.checkoutFrom?.runId === workflowRun.id);
  const detail = stage
    ? `the stage '${stage.launch.workflowName}' its end started`
    : asksCheckout && 'handoff' in asksCheckout && asksCheckout.handoff.runId === workflowRun.id
      ? 'the stage its asks start once answered'
      : undefined;
  return detail ? { disposition: 'retained', reason: 'in_use', detail } : disposition;
}
