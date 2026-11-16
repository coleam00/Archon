/**
 * The asks a workflow declares with `returns: { node, asks: <property> }`: the engine's
 * schema added to the returns node, and the asks a completed run leaves, read when it is
 * about to complete. The schema and its checks live in `schemas/item-ask.ts`.
 */
import type { DagNode, IncludeDirective, NodeOutput, WorkflowRun } from './schemas';
import { isIncludeDirective } from './schemas/node-guards';
import type { WorkflowDefinition } from './schemas/workflow';
import { itemAsksJsonSchema, parseItemAsks, type ItemAsk } from './schemas/item-ask';
import { outputRefText, resolveNodeOutputField } from './output-ref';

/**
 * The workflow with the engine's asks schema added to its returns node's `output_format`
 * as a required property, or the workflow unchanged when it declares no asks. Idempotent. The load-time contract
 * refuses an authored property of that name, so one already present is the engine's.
 */
export function withEngineAskSchema<
  W extends Pick<WorkflowDefinition, 'returns' | 'result'> & {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  },
>(workflow: W): W {
  const field = workflow.result?.asks;
  const returns = workflow.returns;
  if (field === undefined || returns === undefined) return workflow;
  let changed = false;
  const nodes = workflow.nodes.map(node => {
    if (node.id !== returns || isIncludeDirective(node) || node.output_format === undefined)
      return node;
    const raw = node.output_format.properties;
    const properties =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    if (properties[field] !== undefined) return node;
    changed = true;
    // Required, with an empty list meaning nothing to decide: a strict provider refuses an
    // optional property, and the model always answers whether it leaves an ask.
    const required = Array.isArray(node.output_format.required)
      ? (node.output_format.required as unknown[])
      : [];
    return {
      ...node,
      output_format: {
        ...node.output_format,
        properties: { ...properties, [field]: itemAsksJsonSchema() },
        required: required.includes(field) ? required : [...required, field],
      },
    };
  });
  return changed ? { ...workflow, nodes } : workflow;
}

export type CompletedAsksReading =
  /** The run opens no asks: its workflow declares none, or it is a child run. */
  | { readonly kind: 'none' }
  /** The run's asks, possibly none: a declaring run that leaves none still replaces its open set. */
  | { readonly kind: 'asks'; readonly asks: readonly ItemAsk[] }
  | { readonly kind: 'invalid'; readonly error: string };

/**
 * The asks a run completes with. Only a top-level run opens asks: a `workflow:` child has
 * no item of its own, so its asks stay data in the result it hands its parent. A skipped
 * returns node or an absent property leaves no asks. A value that is not a list of asks
 * is invalid: the run fails naming the field instead of completing.
 */
export function readCompletedAsks(
  workflow: Pick<WorkflowDefinition, 'returns' | 'result' | 'name'>,
  run: Pick<WorkflowRun, 'parent_run_id'>,
  nodeOutputs: ReadonlyMap<string, NodeOutput>
): CompletedAsksReading {
  const field = workflow.result?.asks;
  const returns = workflow.returns;
  if (field === undefined || returns === undefined || run.parent_run_id !== null)
    return { kind: 'none' };
  const output = nodeOutputs.get(returns);
  if (output?.state !== 'completed') return { kind: 'asks', asks: [] };
  const subject = `Workflow '${workflow.name}' returns.asks '${field}' on node '${returns}'`;
  let value: unknown;
  try {
    const resolution = resolveNodeOutputField(
      output,
      returns,
      field,
      outputRefText(returns, field)
    );
    value = resolution.kind === 'value' ? resolution.value : undefined;
  } catch (error) {
    return { kind: 'invalid', error: `${subject} could not be read: ${(error as Error).message}` };
  }
  if (value === undefined || value === null) return { kind: 'asks', asks: [] };
  const parsed = parseItemAsks(value);
  return 'problem' in parsed
    ? { kind: 'invalid', error: `${subject}: ${parsed.problem}` }
    : { kind: 'asks', asks: parsed.asks };
}
