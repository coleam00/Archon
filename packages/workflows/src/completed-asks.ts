/**
 * The asks and waits a workflow declares with `returns: { node, asks: <property>, waits:
 * <property> }`: the engine's schemas added to the returns node, and the asks and waits a
 * completed run leaves, read when it is about to complete. The schemas and their checks
 * live in `schemas/item-ask.ts` and `schemas/item-wait.ts`.
 */
import type { DagNode, IncludeDirective, NodeOutput, WorkflowRun } from './schemas';
import { isIncludeDirective } from './schemas/node-guards';
import type { WorkflowDefinition } from './schemas/workflow';
import { itemAsksJsonSchema, parseItemAsks, type ItemAsk } from './schemas/item-ask';
import { itemWaitsJsonSchema, parseItemWaits, type ItemWait } from './schemas/item-wait';
import { outputRefText, resolveNodeOutputField } from './output-ref';

/**
 * The workflow with the engine's asks and waits schemas added to its returns node's
 * `output_format` as required properties, or the workflow unchanged when it declares
 * neither. Idempotent. The load-time contract refuses an authored property of either name,
 * so one already present is the engine's.
 */
export function withEngineResultSchemas<
  W extends Pick<WorkflowDefinition, 'returns' | 'result'> & {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  },
>(workflow: W): W {
  const returns = workflow.returns;
  const added: [string, () => Record<string, unknown>][] = [];
  if (workflow.result?.asks !== undefined) added.push([workflow.result.asks, itemAsksJsonSchema]);
  if (workflow.result?.waits !== undefined)
    added.push([workflow.result.waits, itemWaitsJsonSchema]);
  if (added.length === 0 || returns === undefined) return workflow;
  let changed = false;
  const nodes = workflow.nodes.map(node => {
    if (node.id !== returns || isIncludeDirective(node) || node.output_format === undefined)
      return node;
    const raw = node.output_format.properties;
    let properties =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    let required = Array.isArray(node.output_format.required)
      ? (node.output_format.required as unknown[])
      : [];
    for (const [field, schema] of added) {
      if (properties[field] !== undefined) continue;
      changed = true;
      // Required, with an empty list meaning none: a strict provider refuses an optional
      // property, and the model always answers whether it leaves any.
      properties = { ...properties, [field]: schema() };
      if (!required.includes(field)) required = [...required, field];
    }
    return properties === raw
      ? node
      : { ...node, output_format: { ...node.output_format, properties, required } };
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
 * no item of its own, so its asks stay data in the result it hands its parent. A returns
 * node that was skipped opens nothing and replaces nothing, so asks an earlier run left stay
 * open. A completed one with the property absent leaves none. A value that is not a list of asks
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
  // A returns node that did not complete said nothing about asks: the open set stays as
  // it is. Only a completed node that leaves none replaces it with nothing.
  if (output?.state !== 'completed') return { kind: 'none' };
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

export type CompletedWaitsReading =
  /** The run opens no waits: its workflow declares none, or it is a child run. */
  | { readonly kind: 'none' }
  /** The run's waits, possibly none: a declaring run that leaves none still replaces its open set. */
  | { readonly kind: 'waits'; readonly waits: readonly ItemWait[] }
  | { readonly kind: 'invalid'; readonly error: string };

/**
 * The waits a run completes with, by the rules `readCompletedAsks` reads asks: only a
 * top-level run opens them, a returns node that did not complete replaces nothing, an absent
 * value leaves none, and a value that is not a list of waits fails the run.
 */
export function readCompletedWaits(
  workflow: Pick<WorkflowDefinition, 'returns' | 'result' | 'name'>,
  run: Pick<WorkflowRun, 'parent_run_id'>,
  nodeOutputs: ReadonlyMap<string, NodeOutput>
): CompletedWaitsReading {
  const field = workflow.result?.waits;
  const returns = workflow.returns;
  if (field === undefined || returns === undefined || run.parent_run_id !== null)
    return { kind: 'none' };
  const output = nodeOutputs.get(returns);
  if (output?.state !== 'completed') return { kind: 'none' };
  const subject = `Workflow '${workflow.name}' returns.waits '${field}' on node '${returns}'`;
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
  if (value === undefined || value === null) return { kind: 'waits', waits: [] };
  const parsed = parseItemWaits(value);
  return 'problem' in parsed
    ? { kind: 'invalid', error: `${subject}: ${parsed.problem}` }
    : { kind: 'waits', waits: parsed.waits };
}

/** The asks and waits a completed run leaves on its item, each present when declared. */
export interface CompletedItemFacts {
  readonly asks?: readonly ItemAsk[];
  readonly waits?: readonly ItemWait[];
}

/**
 * The asks and waits a run completes with, or the first that is not of its declared form,
 * with the site the run's failure is logged under. Each is present, even empty, whenever
 * the run declares it: the completing write replaces the open set.
 */
export function readCompletedItemFacts(
  workflow: Pick<WorkflowDefinition, 'returns' | 'result' | 'name'>,
  run: Pick<WorkflowRun, 'parent_run_id'>,
  nodeOutputs: ReadonlyMap<string, NodeOutput>
):
  | { readonly kind: 'facts'; readonly facts: CompletedItemFacts }
  | { readonly kind: 'invalid'; readonly error: string; readonly site: string } {
  const asks = readCompletedAsks(workflow, run, nodeOutputs);
  if (asks.kind === 'invalid') return { ...asks, site: 'dag.asks_invalid_fail' };
  const waits = readCompletedWaits(workflow, run, nodeOutputs);
  if (waits.kind === 'invalid') return { ...waits, site: 'dag.waits_invalid_fail' };
  return {
    kind: 'facts',
    facts: {
      ...(asks.kind === 'asks' ? { asks: asks.asks } : {}),
      ...(waits.kind === 'waits' ? { waits: waits.waits } : {}),
    },
  };
}
