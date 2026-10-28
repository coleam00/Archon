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
 * Recursively inject `additionalProperties: false` on every object schema so a
 * JSON Schema satisfies OpenAI's Structured Outputs strict-mode validator.
 *
 * OpenAI rejects any `object` node that does not declare `additionalProperties:
 * false` (HTTP 400 invalid_json_schema). Claude and most other providers don't
 * require this, so workflow authors write portable `output_format` schemas and
 * the Codex provider adapts them here. Returns a deep clone — the caller's
 * schema object is never mutated.
 *
 * A pre-existing `additionalProperties` on an object — including a value
 * subschema like `additionalProperties: { type: 'string' }` (an open record /
 * map) — is replaced with `false`. OpenAI strict-mode forbids open or typed
 * additional properties, so `false` is the only value the API accepts; keeping
 * the subschema would just re-trigger the HTTP 400 this normalizer exists to fix.
 * Callers that want to warn the author before silently dropping those semantics
 * can inspect the authored additionalProperties value before preparation.
 *
 * Partial oneOf/anyOf/allOf object branches inherit missing properties and
 * required names from enclosing schemas on the same value before closure.
 * These requirements already hold on that value; optional fields stay optional.
 * Explicitly closed branches retain their authored restriction. Unsupported
 * conditional keywords, composition constraints without usable inline property maps,
 * incomplete schema-valued dependencies on composition ancestry,
 * incompatible allOf property name sets, and branch completion
 * that would duplicate a resource identifier or relocate a relative reference
 * across a resource boundary throw before Codex starts.
 *
 * The other strict-mode rule
 * (every key in `properties` must appear in `required`) is intentionally NOT
 * enforced here — forcing it would silently turn optional fields into required
 * ones. See issue #1843.
 */
export function normalizeJsonSchemaForOpenAiStrict(
  schema: Record<string, unknown>
): Record<string, unknown> {
  visitJsonSchema(schema, 'output_format', (node, path) => {
    for (const keyword of ['if', 'then', 'else', 'not']) {
      if (keyword in node) {
        throw new Error(
          `Codex output schema at ${path}.${keyword} cannot preserve this conditional keyword in strict mode. Use complete oneOf/anyOf branches instead.`
        );
      }
    }
  });
  assertCompositionsCanBeClosed(schema);
  const normalized = normalizeNode(schema) as Record<string, unknown>;
  visitJsonSchema(normalized, 'output_format', (node, path) => {
    const constraints = sameInstanceNodes(node);
    if (constraints.some(hasComposition)) {
      const names = new Set(sameInstancePropertyMaps(node).flatMap(map => Object.keys(map)));
      for (const dependency of constraints.flatMap(schemaDependencies)) {
        if (
          sameInstancePropertyMaps(dependency).some(map =>
            [...names].some(name => !Object.hasOwn(map, name))
          )
        ) {
          throw new Error(
            `Codex output schema at ${path} cannot close partial schema-valued dependencies in a composition. Use complete inline dependency object branches declaring all enclosing properties instead.`
          );
        }
      }
    }
    if (!Array.isArray(node.allOf)) return;
    const maps = sameInstancePropertyMaps(node);
    const names = new Set(maps.flatMap(map => Object.keys(map)));
    if (maps.some(map => [...names].some(name => !Object.hasOwn(map, name)))) {
      throw new Error(
        `Codex output schema at ${path}.allOf cannot close intersections with different property name sets. Declare the complete property map on the enclosing object and in explicitly closed branches, or write complete allOf branches.`
      );
    }
  });
  return normalized;
}

interface ObjectConstraints {
  properties: Record<string, unknown>;
  required: string[];
  relocatedProperties: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNode(node: unknown, enclosing?: ObjectConstraints): unknown {
  if (Array.isArray(node)) {
    return node.map(value => normalizeNode(value));
  }
  if (!isRecord(node)) return node;

  const properties = isRecord(node.properties) ? node.properties : undefined;
  const required = Array.isArray(node.required)
    ? node.required.filter((name): name is string => typeof name === 'string')
    : [];
  const constraints: ObjectConstraints = {
    properties: { ...enclosing?.properties, ...properties },
    required: [...new Set([...(enclosing?.required ?? []), ...required])],
    relocatedProperties: inheritedPropertyRelocations(node, enclosing),
  };
  const expand =
    enclosing !== undefined &&
    properties !== undefined &&
    (node.additionalProperties === undefined || node.additionalProperties === true);
  if (expand) {
    assertInheritedPropertiesCanBeCopied(
      enclosing.properties,
      properties,
      constraints.relocatedProperties
    );
  }
  const source = expand
    ? { ...node, properties: constraints.properties, required: constraints.required }
    : node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    // Composition branches constrain the same instance. Property values, items
    // and definitions must not inherit the containing object's fields.
    result[key] =
      isJsonSchemaCompositionKeyword(key) && Array.isArray(value)
        ? value.map(branch => normalizeNode(branch, constraints))
        : normalizeNode(value);
  }
  if (isObjectSchemaNode(result)) result.additionalProperties = false;
  return result;
}

function inheritedPropertyRelocations(
  node: Record<string, unknown>,
  enclosing?: ObjectConstraints
): ReadonlySet<string> {
  const relocated = new Set(enclosing?.relocatedProperties);
  if ('$id' in node) {
    for (const name of Object.keys(enclosing?.properties ?? {})) relocated.add(name);
  }
  if (isRecord(node.properties)) {
    for (const name of Object.keys(node.properties)) relocated.delete(name);
  }
  return relocated;
}

function assertInheritedPropertiesCanBeCopied(
  inherited: Record<string, unknown>,
  local: Record<string, unknown>,
  relocated: ReadonlySet<string>
): void {
  for (const [name, value] of Object.entries(inherited)) {
    if (Object.hasOwn(local, name)) continue;
    visitJsonSchema(value, 'output_format', node => {
      for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
        const reference = node[keyword];
        if (
          relocated.has(name) &&
          typeof reference === 'string' &&
          !/^[a-z][a-z0-9+.-]*:/i.test(reference)
        ) {
          throw new Error(
            `Codex output schema cannot copy a property containing relative ${keyword} across a branch $id boundary. Use complete inline composition branches or absolute property references instead.`
          );
        }
      }
      for (const keyword of ['$id', '$anchor', '$dynamicAnchor']) {
        if (keyword in node) {
          throw new Error(
            `Codex output schema cannot copy a property containing ${keyword} into a conditional branch. Move the reusable schema to one definition and use $ref instead.`
          );
        }
      }
    });
  }
}

function hasComposition(node: Record<string, unknown>): boolean {
  return Object.entries(node).some(
    ([key, value]) => isJsonSchemaCompositionKeyword(key) && Array.isArray(value)
  );
}

function assertCompositionsCanBeClosed(schema: unknown): void {
  visitJsonSchema(schema, 'output_format', (node, path) => {
    const constraints = sameInstanceNodes(node);
    if (!constraints.some(hasComposition)) return;
    for (const constraint of constraints) {
      const reference = ['$ref', '$dynamicRef', '$recursiveRef'].find(key => key in constraint);
      if (
        reference ||
        'patternProperties' in constraint ||
        (!isRecord(constraint.properties) &&
          (isObjectSchemaNode(constraint) || 'required' in constraint))
      ) {
        throw new Error(
          `Codex output schema at ${path} cannot establish safe strict closure for this composition. Use complete inline oneOf/anyOf/allOf object branches with explicit properties instead of same-instance references, patternProperties, or object constraints without a property map.`
        );
      }
    }
  });
}

function sameInstanceNodes(node: unknown): Record<string, unknown>[] {
  if (!isRecord(node)) return [];
  return [
    node,
    ...jsonSchemaChildren(node, '').flatMap(child =>
      child.relation === 'nested' ? [] : sameInstanceNodes(child.node)
    ),
  ];
}

function schemaDependencies(node: Record<string, unknown>): Record<string, unknown>[] {
  return jsonSchemaChildren(node, '').flatMap(child =>
    child.relation === 'dependency' ? [child.node] : []
  );
}

function sameInstancePropertyMaps(node: unknown): Record<string, unknown>[] {
  return sameInstanceNodes(node).flatMap(constraint =>
    isRecord(constraint.properties) ? [constraint.properties] : []
  );
}
