/**
 * The outcome a workflow declares with `returns: { node, outcome }`, and the value a
 * completed run takes from it. The load-time contract, the completion write and dry-run
 * read the declaration through this one module, so they cannot disagree on its forms.
 */
import type { DagNode, IncludeDirective, NodeOutput, RunCompletedOutcome } from './schemas';
import type { WorkflowDefinition } from './schemas/workflow';
import { outputRefText, resolveNodeOutputField } from './output-ref';

/** The two forms an outcome property may take: a boolean, or a string with an `enum`. */
export type OutcomeForm =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The values of a root property declared `{ type: string, enum: [...] }`, or undefined
 * when the property is not declared that way. The enum form is read from the root
 * `properties` only, not through `allOf`/`anyOf`/`oneOf`, so the declared values are the
 * ones the run can complete with and a later reader can bind on.
 */
export function stringEnumValues(
  schema: Record<string, unknown>,
  field: string
): readonly string[] | undefined {
  const property = plainObject(plainObject(schema.properties)?.[field]);
  if (property?.type !== 'string' || !Array.isArray(property.enum)) return undefined;
  const values: unknown[] = property.enum;
  if (values.length === 0 || !values.every(value => typeof value === 'string')) return undefined;
  return values as string[];
}

/**
 * The declared outcome: its field and form, read from the returns node's `output_format`.
 * Undefined when the workflow declares no outcome. A boolean form is assumed when the
 * property is not a string enum; the load-time contract has already refused anything else.
 */
export function declaredOutcome(
  workflow: Pick<WorkflowDefinition, 'returns' | 'result'> & {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  }
): { readonly field: string; readonly form: OutcomeForm } | undefined {
  const field = workflow.result?.outcome;
  if (field === undefined || workflow.returns === undefined) return undefined;
  const node = workflow.nodes.find(candidate => candidate.id === workflow.returns);
  const schema = node !== undefined && 'output_format' in node ? node.output_format : undefined;
  const values = schema === undefined ? undefined : stringEnumValues(schema, field);
  return { field, form: values === undefined ? { kind: 'boolean' } : { kind: 'enum', values } };
}

/** The outcome a value read from the declared field gives, or why it gives none. */
export function outcomeFromValue(
  form: OutcomeForm,
  value: unknown
): RunCompletedOutcome | { readonly invalid: string } {
  if (form.kind === 'boolean') {
    return typeof value === 'boolean'
      ? { kind: 'boolean', value: value ? 'succeeded' : 'failed' }
      : { invalid: 'is not a boolean' };
  }
  return typeof value === 'string' && form.values.includes(value)
    ? { kind: 'enum', value }
    : { invalid: `is not one of ${form.values.map(v => `'${v}'`).join(', ')}` };
}

export type CompletedOutcomeReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'outcome'; readonly outcome: RunCompletedOutcome }
  | { readonly kind: 'invalid'; readonly error: string };

/**
 * The outcome a run completes with, read from its returns node's output when the run is
 * about to complete. None when no outcome is declared or the returns node did not
 * complete (a `when:` can skip it). A completed node whose value is not of the declared
 * form is invalid: the run fails naming the field instead of completing.
 */
export function readCompletedOutcome(
  workflow: Pick<WorkflowDefinition, 'returns' | 'result' | 'name'> & {
    readonly nodes: readonly DagNode[];
  },
  nodeOutputs: ReadonlyMap<string, NodeOutput>
): CompletedOutcomeReading {
  const declared = declaredOutcome(workflow);
  const returns = workflow.returns;
  if (declared === undefined || returns === undefined) return { kind: 'none' };
  const output = nodeOutputs.get(returns);
  if (output?.state !== 'completed') return { kind: 'none' };
  const subject = `Workflow '${workflow.name}' returns.outcome '${declared.field}' on node '${returns}'`;
  let value: unknown;
  try {
    const resolution = resolveNodeOutputField(
      output,
      returns,
      declared.field,
      outputRefText(returns, declared.field)
    );
    value = resolution.kind === 'value' ? resolution.value : undefined;
  } catch (error) {
    return { kind: 'invalid', error: `${subject} could not be read: ${(error as Error).message}` };
  }
  const outcome = outcomeFromValue(declared.form, value);
  return 'invalid' in outcome
    ? { kind: 'invalid', error: `${subject} ${outcome.invalid}` }
    : { kind: 'outcome', outcome };
}
