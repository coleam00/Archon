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
 * incomplete schema-valued dependencies,
 * incompatible property name sets, typed partial branches, incomplete nested
 * redeclarations, and branch completion
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
  assertSameInstanceConstraintsCanBeClosed(schema);
  const normalized = normalizeNode(schema, 'output_format');
  visitJsonSchema(normalized, 'output_format', (node, path) => {
    const constraints = sameInstanceNodes(node);
    for (const dependency of constraints.flatMap(schemaDependencies)) {
      assertDependencyCanBeClosed(node, dependency, path);
    }
    if (!Array.isArray(node.allOf)) return;
    const maps = sameInstancePropertyMaps(node);
    const intersectionNames = new Set(maps.flatMap(map => Object.keys(map)));
    if (maps.some(map => [...intersectionNames].some(name => !Object.hasOwn(map, name)))) {
      throw new Error(
        `Codex output schema at ${path}.allOf cannot close intersections with different property name sets. Declare the complete property map on the enclosing object and in explicitly closed branches, or write complete allOf branches.`
      );
    }
  });
  return normalized;
}

interface ObjectConstraints {
  properties?: Record<string, unknown>;
  required: string[];
  relocatedProperties: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNode(
  node: Record<string, unknown>,
  path: string,
  enclosing?: ObjectConstraints
): Record<string, unknown> {
  const properties = isRecord(node.properties) ? node.properties : undefined;
  const required = Array.isArray(node.required)
    ? node.required.filter((name): name is string => typeof name === 'string')
    : [];
  assertBranchCanBeClosed(node, properties, enclosing, path);
  const constraints: ObjectConstraints = {
    properties:
      properties || enclosing?.properties ? { ...enclosing?.properties, ...properties } : undefined,
    required: [...new Set([...(enclosing?.required ?? []), ...required])],
    relocatedProperties: inheritedPropertyRelocations(node, enclosing),
  };
  const expand =
    enclosing !== undefined &&
    properties !== undefined &&
    (node.additionalProperties === undefined || node.additionalProperties === true);
  if (expand) {
    assertInheritedPropertiesCanBeCopied(
      enclosing.properties ?? {},
      properties,
      constraints.relocatedProperties,
      path
    );
  }
  const source = expand
    ? { ...node, properties: constraints.properties, required: constraints.required }
    : node;
  const result = structuredClone(source);
  for (const child of jsonSchemaChildren(result, path)) {
    Object.assign(
      child.node,
      normalizeNode(
        child.node,
        child.path,
        child.relation === 'composition' ? constraints : undefined
      )
    );
  }
  if (isObjectSchemaNode(result)) result.additionalProperties = false;
  return result;
}

function assertBranchCanBeClosed(
  node: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  enclosing: ObjectConstraints | undefined,
  path: string
): void {
  if (!enclosing || !properties) return;
  const inherited = enclosing.properties ?? {};
  const extra = enclosing.properties
    ? Object.keys(properties).filter(name => !Object.hasOwn(inherited, name))
    : [];
  if (extra.length > 0) {
    throw new Error(
      `Codex output schema at ${path} declares branch-only properties ${extra.join(', ')} that enclosing strict closure forbids. Declare the complete property map on the enclosing object and in its branches instead.`
    );
  }
  const completed = { ...inherited, ...properties };
  const undeclaredRequired = [
    ...(enclosing.required ?? []),
    ...(Array.isArray(node.required) ? node.required : []),
  ].filter(name => typeof name === 'string' && !Object.hasOwn(completed, name));
  if (undeclaredRequired.length > 0) {
    throw new Error(
      `Codex output schema at ${path}.required requires undeclared fields ${undeclaredRequired.join(', ')} that strict closure forbids. Declare the complete property map on the enclosing object and in its branches instead.`
    );
  }
  const missing = Object.keys(inherited).filter(name => !Object.hasOwn(properties, name));
  if (isRecord(node.additionalProperties) && missing.length > 0) {
    throw new Error(
      `Codex output schema at ${path}.additionalProperties cannot close a typed partial branch missing ${missing.join(', ')}. Use a complete inline branch declaring all enclosing properties instead.`
    );
  }
  for (const [name, local] of Object.entries(properties)) {
    assertNestedPropertyMapsComplete(inherited[name], local, `${path}.properties.${name}`);
  }
}

function assertNestedPropertyMapsComplete(parent: unknown, local: unknown, path: string): void {
  if (!isRecord(parent) || !isRecord(local)) return;
  const constraints = [...sameInstanceNodes(parent), ...sameInstanceNodes(local)];
  if (
    constraints.some(node =>
      ['$ref', '$dynamicRef', '$recursiveRef'].some(keyword => keyword in node)
    )
  ) {
    throw new Error(
      `Codex output schema at ${path} cannot establish safe nested closure through a reference redeclaration. Use complete inline nested property schemas on the enclosing object and in its branches instead.`
    );
  }
  for (const parentMap of sameInstancePropertyMaps(parent)) {
    for (const localMap of sameInstancePropertyMaps(local)) {
      assertNestedPropertyNamesMatch(parentMap, localMap, path);
    }
  }
  const required = constraints.flatMap(node => (Array.isArray(node.required) ? node.required : []));
  const maps = [...sameInstancePropertyMaps(parent), ...sameInstancePropertyMaps(local)];
  if (
    maps.some(map => required.some(name => typeof name === 'string' && !Object.hasOwn(map, name)))
  ) {
    throw new Error(
      `Codex output schema at ${path} cannot close nested constraints with undeclared required fields. Use complete inline nested property maps declaring all required fields on both sides instead.`
    );
  }
  const parentChildren = sameInstanceNestedChildren(parent, path);
  for (const child of sameInstanceNestedChildren(local, path)) {
    for (const inherited of parentChildren.filter(
      candidate =>
        candidate.path === child.path ||
        (candidate.relation === 'array-item' &&
          child.relation === 'array-item' &&
          candidate.firstItem <= child.lastItem &&
          child.firstItem <= candidate.lastItem)
    )) {
      assertNestedPropertyMapsComplete(inherited.node, child.node, child.path);
    }
  }
}

function sameInstanceNestedChildren(node: Record<string, unknown>, path: string) {
  return sameInstanceNodes(node).flatMap(constraint =>
    jsonSchemaChildren(constraint, path).filter(
      child => child.relation === 'nested' || child.relation === 'array-item'
    )
  );
}

function assertDependencyCanBeClosed(
  node: Record<string, unknown>,
  dependency: Record<string, unknown>,
  path: string
): void {
  const maps = sameInstancePropertyMaps(node);
  const names = new Set(maps.flatMap(map => Object.keys(map)));
  const required = sameInstanceNodes(node).flatMap(constraint =>
    Array.isArray(constraint.required) ? constraint.required : []
  );
  if (
    maps.some(map => [...names].some(name => !Object.hasOwn(map, name))) ||
    required.some(name => typeof name === 'string' && !names.has(name))
  ) {
    throw new Error(
      `Codex output schema at ${path} cannot close schema-valued dependencies with incomplete or different property maps or undeclared required fields. Use complete inline dependency and enclosing object schemas declaring the same properties and all required fields instead.`
    );
  }
  assertNestedPropertyMapsComplete(node, dependency, path);
}

function assertNestedPropertyNamesMatch(
  parentMap: Record<string, unknown>,
  localMap: Record<string, unknown>,
  path: string
): void {
  const extra = Object.keys(localMap).filter(name => !Object.hasOwn(parentMap, name));
  if (extra.length > 0) {
    throw new Error(
      `Codex output schema at ${path} declares nested branch-only fields ${extra.join(', ')} that enclosing strict closure forbids. Declare these fields in the complete enclosing nested property map instead.`
    );
  }
  const missing = Object.keys(parentMap).filter(name => !Object.hasOwn(localMap, name));
  if (missing.length > 0) {
    throw new Error(
      `Codex output schema at ${path} cannot close a nested property missing enclosing fields ${missing.join(', ')}. Use a complete nested property map in the branch instead.`
    );
  }
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
  relocated: ReadonlySet<string>,
  path: string
): void {
  for (const [name, value] of Object.entries(inherited)) {
    if (Object.hasOwn(local, name)) continue;
    visitJsonSchema(value, `${path}.properties.${name}`, (node, propertyPath) => {
      for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
        const reference = node[keyword];
        if (
          relocated.has(name) &&
          typeof reference === 'string' &&
          !/^[a-z][a-z0-9+.-]*:/i.test(reference)
        ) {
          throw new Error(
            `Codex output schema at ${propertyPath} cannot copy a property containing relative ${keyword} across a branch $id boundary. Use complete inline composition branches or absolute property references instead.`
          );
        }
      }
      for (const keyword of ['$id', '$anchor', '$dynamicAnchor']) {
        if (keyword in node) {
          throw new Error(
            `Codex output schema at ${propertyPath} cannot copy a property containing ${keyword} into a conditional branch. Move the reusable schema to one definition and use $ref instead.`
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

function assertSameInstanceConstraintsCanBeClosed(schema: unknown): void {
  visitJsonSchema(schema, 'output_format', (node, path) => {
    const constraints = sameInstanceNodes(node);
    if (
      !constraints.some(hasComposition) &&
      !constraints.some(node => schemaDependencies(node).length > 0)
    )
      return;
    for (const constraint of constraints) {
      const reference = ['$ref', '$dynamicRef', '$recursiveRef'].find(key => key in constraint);
      if (
        reference ||
        'patternProperties' in constraint ||
        (!isRecord(constraint.properties) &&
          (isObjectSchemaNode(constraint) || 'required' in constraint))
      ) {
        throw new Error(
          `Codex output schema at ${path} cannot establish safe strict closure for these same-instance constraints. Use complete inline oneOf/anyOf/allOf object branches with explicit properties instead of same-instance references, patternProperties, or object constraints without a property map.`
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
      child.relation === 'composition' || child.relation === 'dependency'
        ? sameInstanceNodes(child.node)
        : []
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
