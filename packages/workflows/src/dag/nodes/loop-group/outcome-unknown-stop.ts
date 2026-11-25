import { outcomeUnknownText, readOutcomeUnknownSteps } from '../../../outcome-unknown';
import type { LoopGroupBodyResult, LoopGroupRun, LoopGroupState } from './loop-group-state';

/**
 * Stop the group before its next round when this round left a body step with an unknown
 * outcome, which an aggregate such as an `all_done` fan-out let complete: the next round
 * would run that step again. The run reads the step's own record for its stop reason.
 */
export async function stopOnOutcomeUnknown(
  run: LoopGroupRun,
  state: LoopGroupState,
  i: number
): Promise<LoopGroupBodyResult | undefined> {
  const { ctx, node } = run;
  const held = await readOutcomeUnknownSteps(
    ctx.deps.store,
    ctx.workflowRun,
    run.bodyStepNamePrefix
  );
  if (held.length === 0) return undefined;
  return {
    state: 'failed',
    output: state.lastOutput,
    error: `Loop-group node '${node.id}' stopped after iteration ${String(i)}: ${outcomeUnknownText(held)}`,
    failureKind: 'child_failed',
    ...run.progress.usage,
    loopIterations: i,
  };
}
