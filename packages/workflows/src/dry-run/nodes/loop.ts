import { COMPILED_LOOP_COMMAND, type LoopWithCompiledCommand } from '../../compiled-command';
import { describeUnmetCompletion } from '../../executor-shared';
import type { LoopNode, NodeOutput } from '../../schemas';
import {
  TOLERATED_STUB_REASON,
  hasAuthoredStub,
  loadDryRunCommand,
  recordFailed,
  resolveText,
  stubFor,
  withResolution,
  type DryRunContext,
} from '../context';
import { completionReason, loopIterationCompletes } from '../loop-completion';
import { completedOutput, generatedStubFor } from '../stubs';
import { evaluateLoopCompletion } from '../until-bash';

async function loadLoopTemplate(node: LoopNode, ctx: DryRunContext): Promise<string> {
  if (node.loop.prompt !== undefined) return node.loop.prompt;
  const command = node.loop.command ?? '';
  const compiled = (node.loop as typeof node.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND];
  const hasCompiledError = compiled !== undefined && typeof compiled.error === 'string';
  const hasCompiledPrompt = compiled !== undefined && typeof compiled.prompt === 'string';
  if (hasCompiledError && !hasCompiledPrompt) throw new Error(compiled.error);
  if (hasCompiledPrompt && !hasCompiledError) return compiled.prompt;
  if (compiled !== undefined) {
    throw new Error(
      `Loop node '${node.id}' has malformed compiled command metadata for '${command}' — expected exactly one string prompt or error.`
    );
  }
  return loadDryRunCommand(ctx, node, command);
}

function missingLoopOutput(
  node: LoopNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  resolvedText: string,
  iteration?: number
): NodeOutput | undefined {
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
  const placeholder = completedOutput(node, generatedStubFor(node));
  const toleratedCompletion = loopIterationCompletes(node.loop, placeholder);
  if (
    (!ctx.execCode || node.loop.until_bash === undefined) &&
    toleratedCompletion.kind === 'incomplete'
  ) {
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
  return placeholder;
}

export async function simulateLoop(
  node: LoopNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): Promise<void> {
  let previous = '';
  const template = await loadLoopTemplate(node, ctx);
  let resolvedText = template;
  let last: NodeOutput | undefined;
  let tolerated = false;
  for (let current = 1; current <= node.loop.max_iterations; current++) {
    resolvedText = resolveText(template, ctx, outputs, 'prompt', previous);
    const stub = stubFor(node, ctx, current);
    const hydrated =
      stub === undefined
        ? missingLoopOutput(node, outputs, ctx, resolvedText, iteration)
        : completedOutput(node, stub);
    if (hydrated === undefined) return;
    if (!hasAuthoredStub(node, ctx)) ctx.generatedOutputs.add(hydrated);
    tolerated = stub === undefined;
    const completion = await evaluateLoopCompletion(node, hydrated, outputs, ctx, last);
    last = hydrated;
    previous = hydrated.output;
    if (completion.kind !== 'incomplete') {
      recordLoopCompletion(
        node,
        hydrated,
        outputs,
        ctx,
        resolvedText,
        completionReason(completion, node.loop, current),
        tolerated,
        iteration
      );
      return;
    }
  }
  if (node.loop.on_exhausted === 'complete' && last !== undefined) {
    recordLoopCompletion(
      node,
      last,
      outputs,
      ctx,
      resolvedText,
      `reached max iterations (${String(node.loop.max_iterations)}) ${describeUnmetCompletion(node.loop)}; completed with the last output (on_exhausted: complete)`,
      tolerated,
      iteration
    );
    return;
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

function recordLoopCompletion(
  node: LoopNode,
  hydrated: NodeOutput,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  resolvedText: string,
  reason: string,
  tolerated: boolean,
  iteration?: number
): void {
  if (tolerated) ctx.toleratedMissingStubs.add(node.id);
  outputs.set(node.id, hydrated);
  ctx.trace.push({
    nodeId: node.id,
    nodeType: 'loop',
    state: 'stubbed',
    reason: `${tolerated ? `${TOLERATED_STUB_REASON}; ` : ''}${reason}`,
    resolvedText,
    output: hydrated.output,
    ...(iteration ? { iteration } : {}),
    ...withResolution(node, ctx),
  });
}
