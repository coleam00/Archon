import {
  isObjectSchemaNode,
  visitJsonSchema,
  jsonSchemaChildren,
  isJsonSchemaCompositionKeyword,
  findStrictSchemaIssues,
  type StrictSchemaIssue,
} from './output-schema';

export type PreparedStrictSchemaIssue =
  | StrictSchemaIssue
  | {
      kind: 'unsupported-conversion';
      schemaPath: string;
      message: string;
    };

/** Check the schema sent to a strict provider, including preparation refusals. */
export function findPreparedStrictSchemaIssues(
  schema: Record<string, unknown>
): PreparedStrictSchemaIssue[] {
  let prepared: Record<string, unknown>;
  try {
    prepared = normalizeJsonSchemaForOpenAiStrict(schema);
  } catch (error) {
    return [
      {
        kind: 'unsupported-conversion',
        schemaPath: 'output_format',
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  return findStrictSchemaIssues(prepared, 'output_format');
}

/**
 * Close object schemas for Codex without making partial composition branches
 * forbid their parent's fields. Only one-level, flat object compositions are
 * completed; intersections requiring recursive reasoning fail before execution.
 * Optional fields remain optional (issue #1843).
 */
export function normalizeJsonSchemaForOpenAiStrict(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const result = structuredClone(schema);
  visitJsonSchema(result, 'output_format', (node, path) => {
    for (const keyword of [
      'allOf',
      'dependentRequired',
      'dependentSchemas',
      'if',
      'then',
      'else',
      'not',
      'contains',
      'unevaluatedItems',
    ]) {
      if (keyword in node) refuse(`${path}.${keyword}`);
    }
    for (const child of jsonSchemaChildren(node, path)) {
      if (child.relation === 'dependency') refuse(child.path);
    }
    const compositions = Object.keys(node).filter(isJsonSchemaCompositionKeyword);
    if (compositions.length > 1) refuse(`${path}.${compositions[1]}`);
    if (isObjectSchemaNode(node)) {
      const properties = node.properties;
      if (isRecord(properties)) {
        const forbidden = requiredNames(node).filter(name => !Object.hasOwn(properties, name));
        if (forbidden.length > 0) {
          throw new Error(
            `Codex output schema at ${path}.required names ${forbidden.join(', ')} absent from properties. Strict conversion sets additionalProperties: false, forbidding these required fields. Declare their schemas in properties or correct the required list.`
          );
        }
      }
    }
    for (const keyword of compositions) completeBranches(node, keyword, path);
    if (isObjectSchemaNode(node)) node.additionalProperties = false;
  });
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refuse(path: string): never {
  throw new Error(
    `Codex output schema at ${path} cannot be converted safely in strict mode. Use complete inline oneOf/anyOf branches with flat properties on the enclosing object, or use a provider without strict schema conversion for nested or array intersections.`
  );
}

const unsupportedCompositionKeywords = [
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  '$id',
  '$anchor',
  '$dynamicAnchor',
  'patternProperties',
  'unevaluatedProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'contains',
  'unevaluatedItems',
  'dependencies',
  'dependentSchemas',
  'if',
  'then',
  'else',
  'not',
];

function assertSupportedKeywords(node: Record<string, unknown>, path: string): void {
  for (const keyword of unsupportedCompositionKeywords) {
    if (keyword in node) refuse(`${path}.${keyword}`);
  }
}

function assertFlatProperty(property: Record<string, unknown>, path: string): void {
  assertSupportedKeywords(property, path);
  const types = Array.isArray(property.type) ? property.type : [property.type];
  if (types.includes('object') || types.includes('array')) refuse(`${path}.type`);
  if (isObjectSchemaNode(property)) refuse(`${path}.properties`);
  const composition = Object.keys(property).find(isJsonSchemaCompositionKeyword);
  if (composition) refuse(`${path}.${composition}`);
  const nested = jsonSchemaChildren(property, path)[0];
  if (nested) refuse(nested.path);
}

function assertFlatComposition(node: Record<string, unknown>, path: string): void {
  assertSupportedKeywords(node, path);
  for (const child of jsonSchemaChildren(node, path)) {
    if (child.relation === 'declaration' || child.relation === 'composition') continue;
    if (child.relation !== 'nested' || !child.path.startsWith(`${path}.properties.`)) {
      refuse(child.path);
    }
    assertFlatProperty(child.node, child.path);
  }
}

function completeBranches(parent: Record<string, unknown>, keyword: string, path: string): void {
  assertFlatComposition(parent, path);
  const branches = parent[keyword];
  if (!Array.isArray(branches)) refuse(`${path}.${keyword}`);
  if (!isObjectSchemaNode(parent) && !('required' in parent)) {
    for (const [index, branch] of branches.entries()) {
      if (isRecord(branch)) assertSupportedKeywords(branch, `${path}.${keyword}[${index}]`);
    }
    return;
  }
  const enclosing = isRecord(parent.properties) ? parent.properties : undefined;
  if (!enclosing && (isObjectSchemaNode(parent) || 'required' in parent)) {
    refuse(`${path}.${keyword}`);
  }
  for (const [index, branch] of branches.entries()) {
    if (!isRecord(branch)) continue;
    completeBranch(parent, branch, `${path}.${keyword}[${index}]`);
  }
}

function completeBranch(
  parent: Record<string, unknown>,
  branch: Record<string, unknown>,
  path: string
): void {
  assertFlatComposition(branch, path);
  const nested = Object.keys(branch).find(isJsonSchemaCompositionKeyword);
  if (nested) refuse(`${path}.${nested}`);
  if (!isRecord(branch.properties)) {
    if (isObjectSchemaNode(branch) || 'required' in branch) refuse(path);
    return;
  }
  if (!isRecord(parent.properties)) return;
  const properties = branch.properties;
  const enclosing = parent.properties;
  for (const name of Object.keys(properties)) {
    if (!Object.hasOwn(enclosing, name)) refuse(`${path}.properties.${name}`);
  }
  const required = [...new Set([...requiredNames(parent), ...requiredNames(branch)])];
  if (required.some(name => !Object.hasOwn(enclosing, name))) refuse(`${path}.required`);
  const missing = Object.keys(enclosing).some(name => !Object.hasOwn(properties, name));
  if (
    missing &&
    branch.additionalProperties !== undefined &&
    branch.additionalProperties !== true
  ) {
    refuse(`${path}.additionalProperties`);
  }
  branch.properties = { ...enclosing, ...properties };
  branch.required = required;
}

function requiredNames(node: Record<string, unknown>): string[] {
  return Array.isArray(node.required)
    ? node.required.filter((name): name is string => typeof name === 'string')
    : [];
}
