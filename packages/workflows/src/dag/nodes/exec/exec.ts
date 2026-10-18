import type { ExecNode } from '../../../schemas';
import type { NodeExecutionResult } from '../../../node-record-serialization';
import type { RunLayersContext } from '../../run-context';
import {
  assertCheckoutUntouched,
  checkoutSnapshotExcludes,
  snapshotGuardedNode,
} from '../../checkout-guard';
import { runBudgetedAttempt, runDeterministicNodeWithRetry } from '../../retry';
import { executeBashNode } from './bash';
import { executeScriptNode } from './script';

export async function runExecNode(
  ctx: RunLayersContext,
  node: ExecNode
): Promise<NodeExecutionResult> {
  const iteration = ctx.loopGroupPath.at(-1)?.iteration;
  const excludes = checkoutSnapshotExcludes(ctx.artifactsDir, ctx.stateDir, ctx.logDir);
  const treeBefore = await snapshotGuardedNode(ctx, node, excludes);
  const output = await runDeterministicNodeWithRetry(
    node,
    ctx.platform,
    ctx.conversationId,
    ctx.workflowRun,
    ctx.deps.store,
    ctx.stepNamePrefix + node.id,
    () =>
      runBudgetedAttempt(ctx, node, async reserve => {
        if (node.runtime === 'sh') {
          await reserve();
          return executeBashNode(ctx, node);
        }
        return executeScriptNode(ctx, node, reserve);
      }),
    iteration
  );
  return assertCheckoutUntouched(
    node,
    ctx.cwd,
    excludes,
    treeBefore,
    output,
    ctx.deps,
    ctx.logDir,
    ctx.guardedLayerSnapshots
  );
}
