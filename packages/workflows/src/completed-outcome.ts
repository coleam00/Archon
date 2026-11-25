/**
 * The outcome a workflow declares with `returns: { node, outcome }`, and the value a
 * completed run takes from it. The load-time contract, the completion write and dry-run
 * read the declaration through this one module, so they cannot disagree on its forms.
 */
import type { DagNode, IncludeDirective, NodeOutput, RunCompletedOutcome } from './schemas';
import type { WorkflowDefinition } from './schemas/workflow';
import { outputRefText, resolveNodeOutputField } from './output-ref';
import { workflowRunOutcomeSchema } from './schemas/run-status';

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

/**
 * The values a run of this form can complete with: the enum's values, or the boolean
 * form's names. The one list a binding on an outcome is read against.
 */
export function outcomeValues(form: OutcomeForm): readonly string[] {
  return form.kind === 'enum' ? form.values : workflowRunOutcomeSchema.options;
}

/** The outcome a value read from the declared field gives, or why it gives none. */
export function outcomeFromValue(
  form: OutcomeForm,
  value: unknown
): RunCompletedOutcome | { readonly invalid: string } {
  if (form.kind === 'boolean') {
    return typeof value === 'boolean'
      ? {
          kind: 'boolean',
          value: value
            ? workflowRunOutcomeSchema.enum.succeeded
            : workflowRunOutcomeSchema.enum.failed,
        }
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

/**
 * What a run's ending does to its item: the one rule every reader of an ending calls, the
 * completion write and the static reports alike.
 * - `observes`: the workflow declares `observes: true`; its runs act on the item without
 *   being one of its steps, so its ending neither moves, ends nor stops the item.
 * - `ends`: the outcome is one the workflow lists in `returns.ends`. The engine records an
 *   end on the item, even when the run leaves an ask or a wait. A start the ending causes
 *   does not keep the end from being written: a start of an observing workflow (a check
 *   after a merge) leaves it holding, and a step started on the item opens it, as a run
 *   after `archon workflow end` does.
 * - `moves`: the ending left an ask or a wait.
 * - `stops`: anything else, a run that completed with no outcome included, whatever the
 *   outcome is called. The completing write records the stop. A stage the ending starts on
 *   the item moves it on when its run exists, as any later step does; until then the stop
 *   reader holds the stop back (`listStoppedItemRuns`). A run of an observing workflow
 *   moves nothing, so the stop then shows.
 */
export type ItemFate = 'observes' | 'moves' | 'ends' | 'stops';

export function itemFate(
  workflow: Pick<WorkflowDefinition, 'result' | 'observes'>,
  outcome: string | undefined,
  leaves: { readonly asks: boolean; readonly waits: boolean }
): ItemFate {
  if (workflow.observes === true) return 'observes';
  if (outcome !== undefined && workflow.result?.ends?.includes(outcome) === true) return 'ends';
  return leaves.asks || leaves.waits ? 'moves' : 'stops';
}

/**
 * `itemFate` read before any run, for an ending that leaves no ask or wait, given whether
 * a usable binding starts a step (a workflow that does not observe) on the item for the
 * outcome: such a start moves the item on. A workflow that declares `returns.asks` or
 * `returns.waits` can still leave none, so a reader that reports such a stop says it holds
 * only then.
 */
export function declaredItemFate(
  workflow: Pick<WorkflowDefinition, 'result' | 'observes'>,
  outcome: string,
  startsStep: boolean
): ItemFate {
  const fate = itemFate(workflow, outcome, { asks: false, waits: false });
  return fate === 'stops' && startsStep ? 'moves' : fate;
}
