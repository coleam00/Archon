import type { WorkflowDefinition, DagNode, IncludeDirective } from '../schemas';
import {
  isComposeFanOutNode,
  isIncludeDirective,
  isLoopGroupNode,
  isWorkflowNode,
  loopGroupOutputNodes,
} from '../schemas';
import { isOutputFormatEnforced } from '../schemas/node-ignored-fields';
import { declaredFieldsFromSchema } from '../output-ref';
import { compileOutputSchema } from '../structured-output';

/**
 * Validate the run-level authored-outcome declaration against its selected node.
 *
 * Include aliases are deliberately deferred: `parseWorkflow` can only see the
 * `include:` directive, while `expandWorkflowIncludes` owns rebinding that alias
 * to the flattened child's declared return. The expander calls this same helper
 * on the final flat workflow, where every selected node is executable.
 */
export function validateWorkflowOutcomeDeclaration(
  workflow: Pick<WorkflowDefinition, 'returns' | 'outcome_field'> & {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  }
): string | null {
  const field = workflow.outcome_field;
  if (field === undefined) return null;
  if (workflow.returns === undefined) {
    return `Workflow declares outcome_field: '${field}' without returns: — authored outcome must select a result node explicitly`;
  }

  const selectedNode = workflow.nodes.find(node => node.id === workflow.returns);
  if (selectedNode === undefined) {
    return `Workflow declares returns: '${workflow.returns}' but no top-level node has that id`;
  }
  if (isIncludeDirective(selectedNode)) return null;
  if (isLoopGroupNode(selectedNode)) {
    return `Workflow outcome_field: '${field}' cannot select loop_group node '${workflow.returns}' because loop_group output_format is ignored and its runtime output is raw text; select a schema-enforced collector node instead`;
  }
  if (isWorkflowNode(selectedNode) && selectedNode.fan_out !== undefined) {
    return `Workflow outcome_field: '${field}' cannot select fan-out workflow node '${workflow.returns}' because its runtime output is an aggregate array; select a collector node with a required boolean output instead`;
  }
  if (isComposeFanOutNode(selectedNode)) {
    return `Workflow outcome_field: '${field}' cannot select composed fan-out node '${workflow.returns}' because its runtime output is an aggregate array; select a collector node with a required boolean output instead`;
  }

  return validateOutcomeFieldSchema(workflow.returns, field, selectedNode.output_format);
}

function validateOutcomeFieldSchema(
  nodeId: string,
  field: string,
  schema: DagNode['output_format']
): string | null {
  if (schema === undefined) {
    return `Workflow outcome_field: '${field}' selects node '${nodeId}', but that node declares no output_format`;
  }
  if (schema.type !== 'object') {
    return `Workflow outcome_field: '${field}' requires node '${nodeId}' output_format to declare type: object`;
  }
  const declared = declaredFieldsFromSchema(schema);
  if (!declared?.includes(field)) {
    return `Workflow outcome_field: '${field}' is not declared in node '${nodeId}' output_format properties${declared && declared.length > 0 ? ` (declared: ${declared.join(', ')})` : ''}`;
  }
  if (!Array.isArray(schema.required) || !schema.required.includes(field)) {
    return `Workflow outcome_field: '${field}' must be listed in node '${nodeId}' output_format.required`;
  }
  const properties = schema.properties as Record<string, unknown>;
  const property = properties[field];
  const propertyType =
    property !== null && typeof property === 'object'
      ? (property as { type?: unknown }).type
      : undefined;
  if (propertyType !== 'boolean') {
    return `Workflow outcome_field: '${field}' on node '${nodeId}' must explicitly declare type: boolean`;
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
