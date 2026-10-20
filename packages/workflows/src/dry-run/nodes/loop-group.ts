import { planGraph, resolvedBodyNodes } from '../../graph-plan';
import { describeUnmetCompletion, stripCompletionTags } from '../../executor-shared';
import { loopBodyScope } from '../../dag/loop-scope';
import {
  findLoopGroupTerminalInteraction,
  loopGroupIterationOutput,
} from '../../dag/nodes/loop-group/loop-group-state';
import { resolveNodeModelScope, type WorkflowModelScope } from '../../node-model-resolution';
import type { LoopGroupNode, NodeOutput } from '../../schemas';
import { recordFailed, withResolution, type DryRunContext } from '../context';
import { completionReason, loopIterationCompletes } from '../loop-completion';
import { simulateNodes } from '../simulate';

export async function simulateLoopGroup(
  node: LoopGroupNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): Promise<void> {
  const bodyNodes = resolvedBodyNodes(node.loop_group);
  const terminalInteraction = findLoopGroupTerminalInteraction(bodyNodes);
  // The executor builds the body's per-iteration context from the group's OWN resolved
  // provider and model (dag/dispatch.ts), so the body must simulate against those rather
  // than the enclosing workflow's scope. Everything the executor leaves alone — the
  // workflow-level effort and options — stays as it is. Reporting fields that describe
  // where the inherited model came from travel with it, or a body node would be
  // attributed to a tier it did not resolve through.
  const groupResolution = resolveNodeModelScope(
    node,
    ctx.scope,
    ctx.assistantModels,
    ctx.aiProfile
  );
  const bodyScope: WorkflowModelScope = {
    ...ctx.scope,
    provider: groupResolution.provider,
    model: groupResolution.model,
    preset: groupResolution.preset,
    tier: groupResolution.tier,
    providerOrigin: groupResolution.providerOrigin,
  };
  // Swap the scope and loop snapshot on the context the body is given rather than handing
  // it a copy. `halted` is the one scalar a nested simulation writes back — a gate inside
  // the body sets it — so a spread copy would swallow a pause and let the run continue past
  // it. Restoring in `finally` keeps the group's own trace entry on the enclosing scope and
  // nests correctly when a body contains another loop_group.
  const outerScope = ctx.scope;
  const outerLoopPrevOutputs = ctx.loopPrevOutputs;
  const outerLoopBodyScopes = ctx.loopBodyScopes;
  let loopPrevOutputs: Map<string, NodeOutput> | undefined;
  for (let current = 1; current <= node.loop_group.max_iterations; current++) {
    // A dry run never resumes, so `$LOOP_USER_INPUT` is '' on every iteration, as it is
    // in a real run outside an interactive resume.
    const iterScope = loopBodyScope(bodyNodes, loopPrevOutputs, '', ctx.artifactsDir);
    const bodyPlan = planGraph(bodyNodes);
    const bodyOutputs = new Map(outputs);
    ctx.scope = bodyScope;
    ctx.loopPrevOutputs = loopPrevOutputs ?? new Map();
    ctx.loopBodyScopes = [...outerLoopBodyScopes, iterScope];
    try {
      await simulateNodes(bodyPlan, bodyOutputs, ctx, current, layer => {
        if (
          terminalInteraction === undefined ||
          !layer.some(n => n.id === terminalInteraction.id) ||
          !bodyNodes.some(
            n => n.id !== terminalInteraction.id && bodyOutputs.get(n.id)?.state === 'failed'
          )
        )
          return false;
        bodyOutputs.delete(terminalInteraction.id);
        return true;
      });
    } finally {
      ctx.scope = outerScope;
      ctx.loopPrevOutputs = outerLoopPrevOutputs;
      ctx.loopBodyScopes = outerLoopBodyScopes;
    }
    loopPrevOutputs = bodyOutputs;
    const iterationOutput = loopGroupIterationOutput(bodyNodes, bodyOutputs)?.output ?? '';
    const failed = bodyNodes.some(body => bodyOutputs.get(body.id)?.state === 'failed');
    if (failed) {
      recordFailed(
        node,
        outputs,
        ctx,
        `Loop group body failed at iteration ${String(current)}`,
        undefined,
        iteration
      );
      return;
    }
    if (ctx.halted) return;
    const groupCompletion = loopIterationCompletes(node.loop_group, { output: iterationOutput });
    if (groupCompletion.kind !== 'incomplete') {
      const output = stripCompletionTags(iterationOutput, node.loop_group.until);
      outputs.set(node.id, { state: 'completed', output });
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'loop_group',
        state: 'completed',
        reason: completionReason(groupCompletion, node.loop_group, current),
        output,
        ...(iteration ? { iteration } : {}),
        ...withResolution(node, ctx),
      });
      return;
    }
  }
  recordFailed(
    node,
    outputs,
    ctx,
    `Loop group exceeded max iterations (${String(node.loop_group.max_iterations)}) ${describeUnmetCompletion(node.loop_group)}`,
    undefined,
    iteration
  );
}
