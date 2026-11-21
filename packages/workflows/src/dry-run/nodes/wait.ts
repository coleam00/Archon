import { resolveAttentionAsk } from '../../dag/attention-ask';
import { substituteWaitMessage } from '../../dag/references';
import {
  type AttentionAnswer,
  attentionAnswerSchema,
  attentionAnswerProblem,
} from '../../schemas/workflow-run';
import {
  waitCondition,
  type DagNode,
  type NodeOutput,
  type WaitCondition,
  type WaitNode,
} from '../../schemas';
import type { AttentionOption } from '../../schemas/wait-node';
import { stubFor, type DryRunContext } from '../context';
import { completedOutput, type DryRunStubValue } from '../stubs';

export function simulateWait(
  node: WaitNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): void {
  const condition = waitCondition(node.wait);
  const attention = resolveSimulatedAttentionAsk(node, outputs, ctx);
  const resolvedText = attention?.message;
  const attentionAsk = attention?.trace;
  // An authored stub answers an attention wait, as an answer completes it in a real
  // run. Without one the simulation stops where the run would pause.
  const answer =
    condition.kind === 'attention' && Object.hasOwn(ctx.stubs, node.id)
      ? stubFor(node, ctx)
      : undefined;
  if (answer !== undefined) {
    const hydrated = completedOutput(
      node,
      condition.kind === 'attention'
        ? stubAnswerOutput(node, condition, answer, attention?.options)
        : answer
    );
    outputs.set(node.id, hydrated);
    ctx.trace.push({
      nodeId: node.id,
      nodeType: 'wait',
      state: 'stubbed',
      reason: 'answered by stub',
      resolvedText,
      output: hydrated.output,
      ...(attentionAsk !== undefined ? { attentionAsk } : {}),
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
    ...(attentionAsk !== undefined ? { attentionAsk } : {}),
    ...(iteration ? { iteration } : {}),
  });
  ctx.halted = 'paused';
}

function resolveSimulatedAttentionAsk(
  node: WaitNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext
) {
  const condition = waitCondition(node.wait);
  if (condition.kind !== 'attention') return undefined;
  const render = (text: string): string =>
    substituteWaitMessage(
      text,
      { nodeOutputs: outputs, loopBodyScopes: ctx.loopBodyScopes },
      ctx.inputs
    );
  const ask = resolveAttentionAsk(node.id, condition, outputs, render);
  return {
    ...ask,
    trace: {
      form: condition.form,
      ...(ask.options !== undefined
        ? { options: ask.options.map(({ id, label, does }) => ({ id, label, does })) }
        : {}),
      ...(ask.recommendation !== undefined ? { recommendation: ask.recommendation } : {}),
      ...(ask.labels !== undefined ? { labels: ask.labels } : {}),
      ...(condition.other === true ? { other: true as const } : {}),
    },
  };
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
  options: readonly AttentionOption[] | undefined
): DryRunStubValue {
  // The output contract already held, so a string stub is one JSON document.
  const raw: unknown = typeof answer === 'string' ? JSON.parse(answer) : answer;
  const { value: stubbed, ...fields } = isPlainRecord(raw) ? raw : {};
  const parsed = attentionAnswerSchema.safeParse(fields);
  const chosen = chosenIds(parsed.data);
  const problem = attentionAnswerProblem(
    { form: condition.form, options, other: condition.other },
    { choose: chosen, text: parsed.data?.text ?? '' }
  );
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
