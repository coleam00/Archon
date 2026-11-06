import { resolveAttentionDeclaration, substituteWaitMessage } from '../../dag/references';
import {
  type AttentionAnswer,
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
    const hydrated = completedOutput(
      node,
      condition.kind === 'attention' ? stubAnswerOutput(node, condition, answer, outputs) : answer
    );
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
 * every answer surface does; the form's output contract alone accepts any decision. The
 * output is what the real wait returns: the answer, plus the chosen `select` option's
 * `value`. A stubbed `value` is dropped, because no answer supplies one in a real run.
 */
function stubAnswerOutput(
  node: DagNode,
  condition: Extract<WaitCondition, { kind: 'attention' }>,
  answer: DryRunStubValue,
  outputs: ReadonlyMap<string, NodeOutput>
): DryRunStubValue {
  const { options } = resolveAttentionDeclaration(node.id, condition, outputs);
  const declared = attentionOptions({ form: condition.form, options }).map(option => option.id);
  // The output contract already held, so a string stub is one JSON document.
  const raw: unknown = typeof answer === 'string' ? JSON.parse(answer) : answer;
  const { value: stubbed, ...fields } = isPlainRecord(raw) ? raw : {};
  const parsed = attentionAnswerSchema.safeParse(fields);
  const problem = attentionChoiceProblem(condition.form, declared, chosenIds(parsed.data));
  if (problem !== undefined)
    throw new Error(`Stub for node '${node.id}' (form '${condition.form}') ${problem}`);
  if (parsed.data === undefined) return answer;
  const { data } = parsed;
  const value =
    condition.form === 'select' && 'decision' in data
      ? options?.find(option => option.id === data.decision)?.value
      : undefined;
  if (value === undefined) return stubbed === undefined ? answer : data;
  return { ...data, value };
}

/** The option ids an answer chooses; an unparseable answer chooses nothing. */
function chosenIds(answer: AttentionAnswer | undefined): readonly string[] {
  if (answer === undefined) return [];
  if ('decisions' in answer) return answer.decisions;
  return 'decision' in answer ? [answer.decision] : [];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
