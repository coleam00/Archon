import type { WorkflowDefinition, DagNode, IncludeDirective } from '../schemas';
import {
  isComposeFanOutNode,
  isIncludeDirective,
  isLoopGroupNode,
  isWorkflowNode,
  loopGroupOutputNodes,
} from '../schemas';
import { isOutputFormatEnforced } from '../schemas/node-ignored-fields';
import { declaredFieldsFromSchema, outputFieldConstraints } from '../output-ref';
import { compileOutputSchema } from '../structured-output';
import { declaredOutcome, outcomeValues, stringEnumValues } from '../completed-outcome';
import { itemAsksJsonSchema } from '../schemas/item-ask';
import { itemWaitsJsonSchema } from '../schemas/item-wait';
import { observesItem } from '../schemas/run-metadata';
import { isDeepStrictEqual } from 'node:util';

/**
 * Validate the result contract (`returns: { node, outcome, asks, options, waits, ends, summary }`) against its selected node.
 *
 * Include aliases are deliberately deferred: `parseWorkflow` can only see the
 * `include:` directive, while `expandWorkflowIncludes` owns rebinding that alias
 * to the flattened child's declared return. The expander calls this same helper
 * on the final flat workflow, where every selected node is executable.
 */
export function validateWorkflowResultContract(
  workflow: Pick<WorkflowDefinition, 'name' | 'returns' | 'result' | 'observes'> & {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  }
): string | null {
  if (workflow.result?.options !== undefined && workflow.result.asks === undefined)
    return 'Workflow returns.options declares the options of asks; declare returns.asks too';
  const declared = declaredResultFields(workflow.result);
  const ends = workflow.result?.ends;
  if (ends !== undefined && workflow.result?.outcome === undefined)
    return 'Workflow declares returns.ends but no returns.outcome; returns.ends names outcomes, so it needs returns.outcome';
  if (ends !== undefined && observesItem(workflow))
    return 'Workflow declares both observes: true and returns.ends; a run that observes an item is not one of its steps, so it never ends the item';
  const [first] = declared;
  if (first === undefined) return null;
  if (workflow.returns === undefined)
    return `Workflow declares returns.${first.key}: '${first.field}' without a returns node`;
  const shared = sharedPropertyError(declared);
  if (shared !== null) return shared;
  const selectedNode = workflow.nodes.find(node => node.id === workflow.returns);
  if (selectedNode === undefined) {
    return `Workflow declares returns: '${workflow.returns}' but no top-level node has that id`;
  }
  if (isIncludeDirective(selectedNode)) return null;
  for (const { key, field, engineSchema } of declared) {
    const error = resultFieldError(
      workflow.name,
      key,
      field,
      workflow.returns,
      selectedNode,
      engineSchema
    );
    if (error !== null) return error;
  }
  return ends === undefined ? null : endingOutcomesError(workflow, ends);
}

/**
 * Each `returns.ends` entry is a value the declared outcome can take, named once. Checked
 * after the outcome's own schema, so the form it is read against is a valid one.
 */
function endingOutcomesError(
  workflow: Parameters<typeof declaredOutcome>[0],
  ends: readonly string[]
): string | null {
  const outcome = declaredOutcome(workflow);
  // Unreachable: the outcome was validated before this runs.
  if (outcome === undefined) return null;
  const values = outcomeValues(outcome.form);
  for (const [index, value] of ends.entries()) {
    if (!values.includes(value))
      return `Workflow returns.ends names '${value}', which returns.outcome: '${outcome.field}' cannot take (it takes: ${values.join(', ')})`;
    if (ends.indexOf(value) !== index)
      return `Workflow returns.ends names '${value}' twice; name each outcome once`;
  }
  return null;
}

/** A property the result contract names; `engineSchema` for one whose schema the engine owns. */
interface DeclaredResultField {
  key: 'outcome' | 'asks' | 'waits' | 'summary';
  field: string;
  engineSchema?: () => Record<string, unknown>;
}

function declaredResultFields(result: WorkflowDefinition['result']): DeclaredResultField[] {
  const fields: DeclaredResultField[] = [];
  if (result?.outcome !== undefined) fields.push({ key: 'outcome', field: result.outcome });
  if (result?.asks !== undefined) {
    const options = result.options;
    fields.push({
      key: 'asks',
      field: result.asks,
      engineSchema: () => itemAsksJsonSchema(options),
    });
  }
  if (result?.waits !== undefined)
    fields.push({ key: 'waits', field: result.waits, engineSchema: itemWaitsJsonSchema });
  if (result?.summary !== undefined) fields.push({ key: 'summary', field: result.summary });
  return fields;
}

/** Each part of the contract is a different value, so two may not name one property. */
function sharedPropertyError(declared: readonly DeclaredResultField[]): string | null {
  for (const [index, { key, field }] of declared.entries()) {
    const other = declared.slice(0, index).find(earlier => earlier.field === field);
    if (other !== undefined)
      return `Workflow returns.${key}: '${field}' names the same property as returns.${other.key}; each names a different value`;
  }
  return null;
}

/** Why the selected node cannot carry one declared property, or null. */
function resultFieldError(
  workflowName: string,
  key: DeclaredResultField['key'],
  field: string,
  nodeId: string,
  node: DagNode,
  engineSchema: DeclaredResultField['engineSchema']
): string | null {
  const subject = `Workflow returns.${key}: '${field}'`;
  if (key === 'summary')
    return (
      selectedNodeShapeError(subject, nodeId, node, 'a string summary property') ??
      validateSummaryFieldSchema(subject, nodeId, field, node.output_format)
    );
  if (engineSchema === undefined)
    return (
      selectedNodeShapeError(subject, nodeId, node, 'a required outcome property') ??
      validateOutcomeFieldSchema(workflowName, subject, nodeId, field, node.output_format)
    );
  return (
    selectedNodeShapeError(subject, nodeId, node, 'an object output_format') ??
    validateEngineFieldSchema(subject, nodeId, field, node, engineSchema())
  );
}

/** Why the returns node cannot carry a property the engine reads: its output is no object it declares. */
function selectedNodeShapeError(
  subject: string,
  nodeId: string,
  node: DagNode,
  needs: string
): string | null {
  if (isLoopGroupNode(node)) {
    return `${subject} cannot select loop_group node '${nodeId}' because loop_group output_format is ignored and its runtime output is raw text; select a schema-enforced collector node instead`;
  }
  if (isWorkflowNode(node) && node.fan_out !== undefined) {
    return `${subject} cannot select fan-out workflow node '${nodeId}' because its runtime output is an aggregate array; select a collector node with ${needs} instead`;
  }
  if (isComposeFanOutNode(node)) {
    return `${subject} cannot select composed fan-out node '${nodeId}' because its runtime output is an aggregate array; select a collector node with ${needs} instead`;
  }
  return null;
}

/**
 * An asks or waits property is the engine's: the node declares an object output, and the
 * property is either absent (the loader adds it) or exactly the engine's schema, which it is
 * after the loader added it and this check runs again on the expanded or dispatched workflow.
 */
function validateEngineFieldSchema(
  subject: string,
  nodeId: string,
  field: string,
  node: DagNode,
  engineSchema: Record<string, unknown>
): string | null {
  const schema = node.output_format;
  if (schema === undefined || !isOutputFormatEnforced(node)) {
    return `${subject} selects node '${nodeId}', but that node declares no output_format the engine enforces; give it an object output_format`;
  }
  if (!outputFieldConstraints(schema, field).object) {
    return `${subject} requires node '${nodeId}' output_format to declare type: object`;
  }
  const properties = schema.properties;
  const declared =
    properties !== null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)[field]
      : undefined;
  if (declared !== undefined && !isDeepStrictEqual(declared, engineSchema)) {
    return `${subject} on node '${nodeId}': the engine defines this property; remove it from output_format`;
  }
  return null;
}

/** A summary is shown as text, so the node declares it as a string; it need not be required. */
function validateSummaryFieldSchema(
  subject: string,
  nodeId: string,
  field: string,
  schema: DagNode['output_format']
): string | null {
  if (schema === undefined) {
    return `${subject} selects node '${nodeId}', but that node declares no output_format`;
  }
  if (!outputFieldConstraints(schema, field).object) {
    return `${subject} requires node '${nodeId}' output_format to declare type: object`;
  }
  const properties = schema.properties;
  const declared =
    properties !== null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)[field]
      : undefined;
  const type =
    declared !== null && typeof declared === 'object' && !Array.isArray(declared)
      ? (declared as Record<string, unknown>).type
      : undefined;
  if (type !== 'string') {
    return `${subject} must be declared in node '${nodeId}' output_format properties with type: string`;
  }
  return null;
}

function validateOutcomeFieldSchema(
  workflowName: string,
  subject: string,
  nodeId: string,
  field: string,
  schema: DagNode['output_format']
): string | null {
  if (schema === undefined) {
    return `${subject} selects node '${nodeId}', but that node declares no output_format`;
  }
  const constraints = outputFieldConstraints(schema, field);
  if (!constraints.object) {
    return `${subject} requires node '${nodeId}' output_format to declare type: object`;
  }
  const declared = declaredFieldsFromSchema(schema);
  if (!declared?.includes(field)) {
    return `${subject} is not declared in node '${nodeId}' output_format properties${declared && declared.length > 0 ? ` (declared: ${declared.join(', ')})` : ''}`;
  }
  if (!constraints.required) {
    return `${subject} must be listed in node '${nodeId}' output_format.required`;
  }
  if (constraints.boolean) return null;
  const values = stringEnumValues(schema, field);
  if (values === undefined) {
    return `${subject} on node '${nodeId}' must declare type: boolean, or type: string with a non-empty enum of strings`;
  }
  // An outcome is a name an operator and a later stage read. An empty one says nothing,
  // and admitting it would make every reader special-case '' against "no outcome".
  if (values.includes('')) {
    return `Workflow '${workflowName}' returns.outcome: '${field}' on node '${nodeId}' declares an empty string in its enum; an outcome must be a name, so give it one`;
  }
  return null;
}

/**
 * Whether the run budget counts each node kind's work and spend. Keyed by every kind so
 * a new kind fails the type-check until it is classified. `include` is judged after
 * expansion, by the kinds it flattens into.
 */
const RUN_BUDGET_SUPPORTS_KIND: Record<(DagNode | IncludeDirective)['kind'], boolean> = {
  agent: true,
  exec: true,
  gate: true,
  halt: true,
  wait: true,
  include: true,
  loop: false,
  loop_group: false,
  workflow: false,
  compose_fan_out: false,
};

/**
 * Reject node shapes whose work or spend the run budget does not yet count.
 *
 * Runs on the flattened graph too (`expandWorkflowIncludes`), so a loop reached
 * through `include:` is caught. An included workflow's own `budget:` is dropped
 * like any run-owned field; the composing run's budget governs every node.
 */
export function validateRunBudgetShape(
  workflow: Pick<WorkflowDefinition, 'budget'> & {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  }
): string | null {
  if (workflow.budget === undefined) return null;
  const node = workflow.nodes.find(n => !RUN_BUDGET_SUPPORTS_KIND[n.kind]);
  if (node === undefined) return null;
  const shape = node.kind === 'compose_fan_out' ? 'include with fan_out' : node.kind;
  return `Workflow declares budget: but node '${node.id}' is a ${shape} node, whose work and spend the run budget does not count yet (loops, workflow: child runs and fan-out are not supported under a run budget). Remove budget: or restructure the workflow without that node.`;
}

/**
 * A `workflow:` node may not declare `output_format` (#2453). The result contract
 * belongs to the node that produces the value — the child's `returns:` node — and
 * its declared field names travel back with the result, so the caller has nothing
 * to assert. Checked before the compile gate in both the file-fed loader and the
 * in-memory validator, through this one function, so both name the same owner and
 * a caller schema never reaches the compile branch. Returns the load error, or
 * `null` for every other node.
 */
export function workflowNodeOutputFormatError(node: DagNode): string | null {
  if (!isWorkflowNode(node) || node.output_format === undefined) return null;
  return `Node '${node.id}' declares output_format on a workflow: node; the result contract belongs to the child's returns: node — declare it there`;
}

/**
 * Compile every declared `output_format` so a contract that cannot be enforced
 * is rejected at LOAD time, before a provider is paid (#2453).
 *
 * `output_format` is free-form JSON Schema to Zod (`z.record`), so nothing before
 * this point can tell a real schema from one ajv will refuse. The runtime gates
 * used to warn and continue on that refusal, which silently turned a declared
 * contract into no contract at all after the spend. They now fail the node, and
 * this check is what keeps that failure from being the author's first signal.
 *
 * ajv stays `strict: false`, so a schema carrying tolerated annotations (unknown
 * keywords, unknown formats) still compiles and still loads — only a schema ajv
 * genuinely rejects, such as a dangling `$ref`, is an error here.
 *
 * Loop_group bodies are walked too: a body node runs its own provider turn with
 * its own schema, while the group's own `output_format` stays inert and is skipped.
 * Returns the first failure message, or `null`.
 */
export function validateNodeOutputFormats(
  nodes: readonly (DagNode | IncludeDirective)[]
): string | null {
  for (const node of nodes) {
    if (isIncludeDirective(node)) continue;
    // Ownership first (#2453): a `workflow:` node's schema is rejected outright, so the
    // compile gate below never sees one.
    const ownershipError = workflowNodeOutputFormatError(node);
    if (ownershipError !== null) return ownershipError;
    const schemaError = nodeOutputFormatCompileError(node);
    if (schemaError !== null) return schemaError;
    if (isLoopGroupNode(node)) {
      const bodyError = validateNodeOutputFormats(node.loop_group.nodes);
      if (bodyError) return bodyError;
    }
  }
  return null;
}

function nodeOutputFormatCompileError(node: DagNode): string | null {
  const toolError = scriptToolsCompileError(node);
  if (toolError !== null) return toolError;
  // Only a schema the engine will enforce is worth rejecting. Where the field is
  // inert (warned and ignored) a dangling `$ref` governs nothing and must not fail
  // the file; the predicate derives from the ignored-field lists, so it stays true
  // as those lists change.
  if (isOutputFormatEnforced(node) && node.output_format !== undefined) {
    const compileError = compileOutputSchema(node.output_format);
    if (compileError !== null) {
      return `Node '${node.id}' declares an output_format that cannot be compiled: ${compileError}`;
    }
  }
  return null;
}

/** A root `type` without "string" means the node's output is serialized JSON, never prose. */
function outputSchemaExcludesStrings(schema: Record<string, unknown>): boolean {
  const { type } = schema;
  if (type === undefined) return false;
  return Array.isArray(type) ? !type.includes('string') : type !== 'string';
}

export function validateLoopGroupProseCompletion(
  nodes: readonly (DagNode | IncludeDirective)[]
): string | null {
  for (const node of nodes) {
    if (isIncludeDirective(node) || !isLoopGroupNode(node)) continue;
    const bodyError = validateLoopGroupProseCompletion(node.loop_group.nodes);
    if (bodyError) return bodyError;
    if (node.loop_group.until === undefined || node.loop_group.until_bash !== undefined) continue;
    // Any candidate can be the one an iteration's output is read from.
    const outputNode = loopGroupOutputNodes(node.loop_group.nodes).find(
      candidate =>
        !isIncludeDirective(candidate) &&
        isOutputFormatEnforced(candidate) &&
        candidate.output_format !== undefined &&
        outputSchemaExcludesStrings(candidate.output_format)
    );
    if (outputNode !== undefined) {
      return `loop_group '${node.id}': node '${outputNode.id}', which the group's output is read from, declares a non-string output_format, so the prose until signal cannot be detected in serialized structured output. Use loop_group.until_bash to read that node's structured field instead`;
    }
  }
  return null;
}

/** A declared tool's input must be an object, and both of its schemas must compile. */
function scriptToolsCompileError(node: DagNode): string | null {
  if (node.kind !== 'agent') return null;
  for (const [name, tool] of Object.entries(node.tools ?? {})) {
    if (tool.input_schema.type !== 'object')
      return `Node '${node.id}', tool '${name}': input_schema must declare type: object`;
    for (const field of ['input_schema', 'output_schema'] as const) {
      const error = compileOutputSchema(tool[field]);
      if (error !== null)
        return `Node '${node.id}', tool '${name}': ${field} cannot be compiled: ${error}`;
    }
  }
  return null;
}
