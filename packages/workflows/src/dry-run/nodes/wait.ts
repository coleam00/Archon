import { resolveAttentionOptions, substituteWaitMessage } from '../../dag/references';
import {
  attentionAnswerSchema,
  attentionChoiceProblem,
  attentionOptions,
} from '../../schemas/workflow-run';
import {
  waitCondition,
  type DagNode,
  type NodeOutput,
  type WaitCondition,
  type WaitNode,
} from '../../schemas';
import { stubFor, type DryRunContext } from '../context';
import { completedOutput, type DryRunStubValue } from '../stubs';

export function simulateWait(
  node: WaitNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): void {
  const condition = waitCondition(node.wait);
  const resolvedText =
    condition.kind === 'attention'
      ? substituteWaitMessage(
          condition.message,
          { nodeOutputs: outputs, loopBodyScopes: ctx.loopBodyScopes },
          ctx.inputs
        ).trim()
      : undefined;
  // An authored stub answers an attention wait, as an answer completes it in a real
  // run. Without one the simulation stops where the run would pause.
  const answer =
    condition.kind === 'attention' && Object.hasOwn(ctx.stubs, node.id)
      ? stubFor(node, ctx)
      : undefined;
  if (answer !== undefined) {
    if (condition.kind === 'attention')
      assertStubAnswerChoosesDeclared(node, condition, answer, outputs);
    const hydrated = completedOutput(node, answer);
    outputs.set(node.id, hydrated);
    ctx.trace.push({
      nodeId: node.id,
      nodeType: 'wait',
      state: 'stubbed',
      reason: 'answered by stub',
      resolvedText,
      output: hydrated.output,
      ...(iteration ? { iteration } : {}),
    });
    return;
  }
  outputs.set(node.id, { state: 'pending', output: '' });
  ctx.trace.push({
    nodeId: node.id,
    nodeType: 'wait',
    state: 'paused',
    reason: 'durable wait',
    ...(resolvedText !== undefined ? { resolvedText } : {}),
    ...(iteration ? { iteration } : {}),
  });
  ctx.halted = 'paused';
}

/**
 * Hold an authored answer to an attention wait to the options the wait declares, as
 * every answer surface does; the form's output contract alone accepts any decision.
 */
function assertStubAnswerChoosesDeclared(
  node: DagNode,
  condition: Extract<WaitCondition, { kind: 'attention' }>,
  answer: DryRunStubValue,
  outputs: ReadonlyMap<string, NodeOutput>
): void {
  const options = resolveAttentionOptions(node.id, condition.options, outputs);
  const declared = attentionOptions({ form: condition.form, options }).map(option => option.id);
  // The output contract already held, so a string stub is one JSON document. A parse
  // failure is an empty decision or decision list, which chooses nothing.
  const parsed = attentionAnswerSchema.safeParse(
    typeof answer === 'string' ? JSON.parse(answer) : answer
  );
  const choose = !parsed.success
    ? []
    : 'decisions' in parsed.data
      ? parsed.data.decisions
      : 'decision' in parsed.data
        ? [parsed.data.decision]
        : [];
  const problem = attentionChoiceProblem(condition.form, declared, choose);
  if (problem !== undefined)
    throw new Error(`Stub for node '${node.id}' (form '${condition.form}') ${problem}`);
}
