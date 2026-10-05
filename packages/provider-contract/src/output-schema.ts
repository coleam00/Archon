/**
 * True when `node`'s shape marks it as a JSON-Schema object node: it declares
 * `type: 'object'` (or a type union including `'object'`) or carries a
 * `properties` map. OpenAI strict-mode requires `additionalProperties: false`
 * on exactly these nodes.
 */
export function isObjectSchemaNode(node: Record<string, unknown>): boolean {
  const typeIncludesObject =
    node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
  return typeIncludesObject || 'properties' in node;
}

// ─── Strict-mode schema issue detection ───────────────────────────────────────

/**
 * A schema issue that OpenAI strict mode rejects. `schemaPath` is a dotted path
 * from the schema root (e.g. `"output_format.properties.status"`).
 */
export type StrictSchemaIssue =
  | {
      kind: 'missing-properties';
      /** Dotted path from the schema root */
      schemaPath: string;
    }
  | {
      kind: 'missing-required';
      /** Dotted path from the schema root */
      schemaPath: string;
      /** Property keys declared in `properties` but absent from `required` */
      missing: string[];
    };

/**
 * Find every object schema node, at any depth, that omits `properties` or whose
 * declared property keys are not fully covered by its `required` array.
 *
 * `basePath` is prepended to every issue path so callers get meaningful
 * schema-root-relative locations (e.g. pass `'output_format'`).
 */
export function findStrictSchemaIssues(schema: unknown, basePath: string): StrictSchemaIssue[] {
  return collectStrictSchemaIssues(schema, basePath);
}

function collectStrictSchemaIssues(
  schema: unknown,
  path: string,
  out: StrictSchemaIssue[] = []
): StrictSchemaIssue[] {
  if (schema === null || typeof schema !== 'object') return out;
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => collectStrictSchemaIssues(item, `${path}[${i}]`, out));
    return out;
  }
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (isObjectSchemaNode(record) && !('properties' in record)) {
    out.push({ kind: 'missing-properties', schemaPath: path });
  }
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const required = new Set(Array.isArray(record.required) ? (record.required as string[]) : []);
    const missing = Object.keys(properties).filter(key => !required.has(key));
    if (missing.length > 0) out.push({ kind: 'missing-required', schemaPath: path, missing });
  }

  const collectSchema = (key: string): void => {
    if (key in record) collectStrictSchemaIssues(record[key], `${path}.${key}`, out);
  };
  const collectSchemaArray = (key: string): void => {
    const schemas = record[key];
    if (!Array.isArray(schemas)) return;
    schemas.forEach((item, index) =>
      collectStrictSchemaIssues(item, `${path}.${key}[${index}]`, out)
    );
  };
  const collectSchemaMap = (key: string): void => {
    const schemas = record[key];
    if (schemas === null || typeof schemas !== 'object' || Array.isArray(schemas)) return;
    for (const [name, subschema] of Object.entries(schemas)) {
      collectStrictSchemaIssues(subschema, `${path}.${key}.${name}`, out);
    }
  };

  for (const key of [
    'additionalProperties',
    'unevaluatedProperties',
    'propertyNames',
    'contains',
    'not',
    'if',
    'then',
    'else',
    'contentSchema',
  ]) {
    collectSchema(key);
  }
  if (Array.isArray(record.items)) collectSchemaArray('items');
  else collectSchema('items');
  for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) collectSchemaArray(key);
  for (const key of [
    'properties',
    'patternProperties',
    'dependentSchemas',
    'dependencies',
    '$defs',
    'definitions',
  ]) {
    collectSchemaMap(key);
  }
  return out;
}
