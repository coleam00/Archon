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
  const issues: StrictSchemaIssue[] = [];
  visitJsonSchema(schema, basePath, (node, path) => collectObjectIssues(node, path, issues));
  return issues;
}

type JsonSchemaEdge =
  | { kind: 'array'; relation: 'composition' }
  | { kind: 'map'; relation: 'dependency' }
  | {
      kind: 'schema' | 'array' | 'map' | 'schema-or-array';
      relation: 'same-instance' | 'nested' | 'array-item' | 'declaration';
    };

const schemaEdges: Readonly<Record<string, JsonSchemaEdge | undefined>> = {
  additionalProperties: { kind: 'schema', relation: 'nested' },
  unevaluatedProperties: { kind: 'schema', relation: 'nested' },
  propertyNames: { kind: 'schema', relation: 'nested' },
  contains: { kind: 'schema', relation: 'array-item' },
  additionalItems: { kind: 'schema', relation: 'array-item' },
  unevaluatedItems: { kind: 'schema', relation: 'array-item' },
  not: { kind: 'schema', relation: 'same-instance' },
  if: { kind: 'schema', relation: 'same-instance' },
  then: { kind: 'schema', relation: 'same-instance' },
  else: { kind: 'schema', relation: 'same-instance' },
  contentSchema: { kind: 'schema', relation: 'nested' },
  items: { kind: 'schema-or-array', relation: 'array-item' },
  prefixItems: { kind: 'array', relation: 'array-item' },
  allOf: { kind: 'array', relation: 'composition' },
  anyOf: { kind: 'array', relation: 'composition' },
  oneOf: { kind: 'array', relation: 'composition' },
  properties: { kind: 'map', relation: 'nested' },
  patternProperties: { kind: 'map', relation: 'nested' },
  dependentSchemas: { kind: 'map', relation: 'dependency' },
  dependencies: { kind: 'map', relation: 'dependency' },
  $defs: { kind: 'map', relation: 'declaration' },
  definitions: { kind: 'map', relation: 'declaration' },
};

export function isJsonSchemaCompositionKeyword(key: string): boolean {
  return Object.hasOwn(schemaEdges, key) && schemaEdges[key]?.relation === 'composition';
}

type JsonSchemaChild = {
  node: Record<string, unknown>;
  path: string;
  relation: JsonSchemaEdge['relation'];
};

/** Direct object subschemas, with their relationship to the containing instance. */
export function jsonSchemaChildren(node: Record<string, unknown>, path: string): JsonSchemaChild[] {
  return Object.entries(schemaEdges).flatMap(([key, edge]) =>
    edge ? schemaEdgeChildren(node, key, `${path}.${key}`, edge) : []
  );
}

function schemaEdgeChildren(
  node: Record<string, unknown>,
  key: string,
  path: string,
  edge: JsonSchemaEdge
): JsonSchemaChild[] {
  const value = node[key];
  const children: JsonSchemaChild[] = [];
  const add = (subschema: unknown, childPath: string): void => {
    // Boolean schemas have no children; arrays in dependency maps are property dependencies.
    if (subschema !== null && typeof subschema === 'object' && !Array.isArray(subschema)) {
      children.push({
        node: subschema as Record<string, unknown>,
        path: childPath,
        relation: edge.relation,
      });
    }
  };
  if (edge.kind === 'array' || (edge.kind === 'schema-or-array' && Array.isArray(value))) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => add(item, `${path}[${index}]`));
    }
  } else if (edge.kind === 'map') {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, subschema] of Object.entries(value)) {
        add(subschema, `${path}.${name}`);
      }
    }
  } else {
    add(value, path);
  }
  return children;
}

/** Visit schema nodes, excluding property maps and annotation data. */
export function visitJsonSchema(
  schema: unknown,
  path: string,
  visit: (node: Record<string, unknown>, path: string) => void
): void {
  if (schema === null || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => visitJsonSchema(item, `${path}[${i}]`, visit));
    return;
  }
  const record = schema as Record<string, unknown>;
  visit(record, path);
  for (const child of jsonSchemaChildren(record, path)) {
    visitJsonSchema(child.node, child.path, visit);
  }
}

function collectObjectIssues(
  record: Record<string, unknown>,
  path: string,
  out: StrictSchemaIssue[]
): void {
  const properties = record.properties;
  if (isObjectSchemaNode(record) && !('properties' in record)) {
    out.push({ kind: 'missing-properties', schemaPath: path });
  }
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const required = new Set(Array.isArray(record.required) ? (record.required as string[]) : []);
    const missing = Object.keys(properties).filter(key => !required.has(key));
    if (missing.length > 0) out.push({ kind: 'missing-required', schemaPath: path, missing });
  }
}
