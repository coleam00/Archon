import { findStrictSchemaIssues, isObjectSchemaNode } from '@archon/provider-contract';
import type { StrictSchemaIssue } from '@archon/provider-contract';
import { isExecNode, isOutputFormatEnforced, isWaitNode } from '../schemas';
import { workflowNodeOutputFormatError } from '../loader/contracts';
import { compileOutputSchema } from '../structured-output';
import type { NodeValidation, ResourceValidation } from './context';

/**
 * A node's declared output contract: it belongs to a producer, compiles, suits a
 * strict-mode provider, and is tight enough to reject an incomplete answer.
 */
export function validateOutputFormat(
  validation: ResourceValidation,
  { node, provider, capabilities }: NodeValidation
): void {
  const { issues } = validation;
  // --- Declared contract belongs to a producer, and compiles (#2453) ---
  // parseWorkflow already rejects both an `output_format` on a `workflow:` node and
  // an uncompilable one on an enforced node, so a file-fed caller never reaches these
  // branches. They are kept for the callers that hand this pass a definition built in
  // memory (tests, and any future synthesized or programmatically-assembled
  // workflow), which would otherwise validate clean and then fail at the node
  // boundary after the spend. Same predicate as the loader, so the two gates cannot
  // disagree on an inert schema.
  const ownershipError = workflowNodeOutputFormatError(node);
  const outputSchema =
    ownershipError === null && isOutputFormatEnforced(node) ? node.output_format : undefined;
  const compileError = outputSchema === undefined ? null : compileOutputSchema(outputSchema);
  if (ownershipError !== null) {
    issues.push({
      level: 'error',
      nodeId: node.id,
      field: 'output_format',
      message: ownershipError,
      hint: "Move the schema to the child workflow's returns: node — its declared fields travel back with the result.",
    });
  } else if (compileError !== null) {
    issues.push({
      level: 'error',
      nodeId: node.id,
      field: 'output_format',
      message: `Node '${node.id}' declares an output_format that cannot be compiled: ${compileError}`,
      hint: 'Fix the JSON Schema — a declared contract is enforced against the node output, so it cannot be skipped.',
    });
  }
  if (outputSchema === undefined) return;

  // --- Strict-schema compatibility (#2945, #3557) ---
  // A schema with a bare object or incomplete 'required' coverage is rejected
  // by a provider that enforces OpenAI strict mode (Codex) at the first turn
  // with HTTP 400 invalid_json_schema. Report it at validation time so `archon
  // validate workflows` catches it before a live run burns setup costs. The
  // set of provider-invoking kinds is the same one the launch preflight uses:
  // every node kind that both enforces output_format
  // (isOutputFormatEnforced) AND sends the schema to a provider (agent and
  // loop; not exec/bash/script, and not a wait's engine-injected schema).
  const strictSchemaIssues =
    !isExecNode(node) && !isWaitNode(node) && capabilities?.requiresAllPropertiesRequired
      ? findStrictSchemaIssues(outputSchema, 'output_format')
      : [];
  for (const issue of strictSchemaIssues) {
    issues.push({
      level: 'error',
      nodeId: node.id,
      field: 'output_format',
      ...strictSchemaIssueText(node.id, provider, issue),
    });
  }

  if (
    !isWaitNode(node) &&
    compileError === null &&
    strictSchemaIssues.length === 0 &&
    isLooseObjectSchema(outputSchema)
  ) {
    issues.push({
      level: 'warning',
      nodeId: node.id,
      field: 'output_format',
      message: `Node '${node.id}' declares output_format properties without a non-empty required array or additionalProperties: false. Missing fields or a schema-echo response can validate successfully.`,
      hint: 'List fields that downstream nodes need in required, or set additionalProperties: false to reject undeclared fields. Keep the schema loose only when every field is intentionally optional.',
    });
  }
}

function strictSchemaIssueText(
  nodeId: string,
  provider: string | undefined,
  issue: StrictSchemaIssue
): { message: string; hint: string } {
  if (issue.kind === 'missing-properties') {
    return {
      message: `Node '${nodeId}' declares an object schema without 'properties' at '${issue.schemaPath}'. Provider '${provider}' enforces OpenAI strict mode and will reject this schema (HTTP 400 invalid_json_schema).`,
      hint: 'Declare the object properties and list every property in required. When the value may be absent, use a nullable object such as type: ["object","null"].',
    };
  }
  return {
    message: `Node '${nodeId}' declares properties not in 'required' at '${issue.schemaPath}': ${issue.missing.join(', ')}. Provider '${provider}' enforces OpenAI strict mode and will reject this schema (HTTP 400 invalid_json_schema).`,
    hint: 'List every property key in the required array. Express optionality inside the type (e.g. a ["string","null"] union or an enum sentinel like "none").',
  };
}

/** An object schema that neither requires a field nor rejects undeclared ones. */
function isLooseObjectSchema(schema: Record<string, unknown>): boolean {
  return (
    isObjectSchemaNode(schema) &&
    schema.properties !== undefined &&
    !(Array.isArray(schema.required) && schema.required.length > 0) &&
    schema.additionalProperties !== false
  );
}
