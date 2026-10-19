import { COMPILED_LOOP_COMMAND, type LoopWithCompiledCommand } from '../../compiled-command';
import { describeUnmetCompletion } from '../../executor-shared';
import type { LoopNode, NodeOutput } from '../../schemas';
import {
  TOLERATED_STUB_REASON,
  loadDryRunCommand,
  recordFailed,
  resolveText,
  stubFor,
  withResolution,
  type DryRunContext,
} from '../context';
import { completionReason, loopIterationCompletes } from '../loop-completion';
import { completedOutput, generatedStubFor } from '../stubs';

export async function simulateLoop(
  node: LoopNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): Promise<void> {
  let previous = '';
  let template: string;
  if (node.loop.prompt !== undefined) {
    template = node.loop.prompt;
  } else {
    const command = node.loop.command ?? '';
    const compiled = (node.loop as typeof node.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    const hasCompiledError = compiled !== undefined && typeof compiled.error === 'string';
    const hasCompiledPrompt = compiled !== undefined && typeof compiled.prompt === 'string';
    if (hasCompiledError && !hasCompiledPrompt) {
      throw new Error(compiled.error);
    }
    if (hasCompiledPrompt && !hasCompiledError) {
      template = compiled.prompt;
    } else if (compiled !== undefined) {
      throw new Error(
        `Loop node '${node.id}' has malformed compiled command metadata for '${command}' — expected exactly one string prompt or error.`
      );
    } else {
      template = await loadDryRunCommand(ctx, node, command);
    }
  }
  let resolvedText = template;
  for (let current = 1; current <= node.loop.max_iterations; current++) {
    resolvedText = resolveText(template, ctx, outputs, 'prompt', previous);
    const stub = stubFor(node, ctx);
    if (stub === undefined) {
      ctx.missingStubs.add(node.id);
      if (node.trigger_rule !== 'all_done') {
        recordFailed(
          node,
          outputs,
          ctx,
          `Missing reachable stub for node '${node.id}'`,
          resolvedText,
          iteration
        );
        return;
      }
      // Same tolerance the single-node gate applies (#2869), extended to the loop
      // shape that never reaches it (#2966). One placeholder covers every iteration —
      // `stubFor` is constant for this node — so the question of "which iteration's
      // stub" collapses: `generatedStubFor` builds a loop placeholder that satisfies
      // the node's own completion channel, so a tolerated loop always ends on
      // iteration 1, and never runs a second one.
      const placeholder = completedOutput(node, generatedStubFor(node));
      const toleratedCompletion = loopIterationCompletes(node.loop, placeholder);
      if (toleratedCompletion.kind === 'incomplete') {
        // The tolerance claim waits for a placeholder that actually carries the node,
        // exactly as the join gate waits for one that can be generated at all. A
        // placeholder that ends no iteration would burn `max_iterations` and fail —
        // calling that tolerated would let `checkFixture` filter away the real blocker.
        recordFailed(
          node,
          outputs,
          ctx,
          `Missing reachable stub for node '${node.id}' — trigger_rule: all_done cannot tolerate it: a generated placeholder would run to max_iterations ${describeUnmetCompletion(node.loop)}`,
          resolvedText,
          iteration
        );
        return;
      }
      ctx.toleratedMissingStubs.add(node.id);
      outputs.set(node.id, placeholder);
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'loop',
        state: 'stubbed',
        reason: `${TOLERATED_STUB_REASON}; ${completionReason(toleratedCompletion, node.loop, current)}`,
        resolvedText,
        output: placeholder.output,
        ...(iteration ? { iteration } : {}),
        ...withResolution(node, ctx),
      });
      return;
    }
    const hydrated = completedOutput(node, stub);
    previous = hydrated.output;
    const completion = loopIterationCompletes(node.loop, hydrated);
    if (completion.kind !== 'incomplete') {
      outputs.set(node.id, hydrated);
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'loop',
        state: 'stubbed',
        reason: completionReason(completion, node.loop, current),
        resolvedText,
        output: previous,
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
    `Loop exceeded max iterations (${String(node.loop.max_iterations)}) ${describeUnmetCompletion(node.loop)}`,
    resolvedText,
    iteration
  );
}
