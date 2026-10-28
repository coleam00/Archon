import { jsonrepair } from 'jsonrepair';
import {
  isObjectSchemaNode,
  visitJsonSchema,
  jsonSchemaChildren,
  isJsonSchemaCompositionKeyword,
} from '@archon/provider-contract';

/**
 * Append a "respond with JSON matching this schema" instruction to the user
 * prompt, for a best-effort provider that has no structured channel. Pi asks
 * for its `structured_output` tool call instead.
 */
export function augmentPromptForJsonSchema(
  prompt: string,
  schema: Record<string, unknown>
): string {
  return `${prompt}

---

CRITICAL: Respond with ONLY a JSON object matching the schema below. No prose before or after the JSON. No markdown code fences. Just the raw JSON object as your final message.

Schema:
${JSON.stringify(schema, null, 2)}`;
}

/**
 * Attempt to parse an assistant transcript as the structured-output JSON object.
 * Handles four common model failure modes, in tiers:
 *  - trailing/leading whitespace (always stripped)
 *  - markdown code fences (```json ... ``` or bare ``` ... ```) that models
 *    emit despite the "no code fences" instruction in the prompt
 *  - prose preamble followed by a single trailing JSON object — pattern
 *    observed on Minimax M2.7 reasoning models that "think out loud" before
 *    emitting structured output despite explicit JSON-only prompts
 *  - structural corruption (trailing commas, single quotes, unquoted keys, a
 *    `max_tokens`-truncated tail) repaired via jsonrepair (tier 3)
 *
 * The contract is a JSON OBJECT: top-level arrays/primitives return `undefined`
 * (the augmentation always asks for an object, and `output_format` is an object
 * schema). Returns the parsed object on success, `undefined` on any failure.
 * `undefined` means "structured output unavailable" — for a node that declared
 * `output_format`, the dag-executor fails the node (fail-fast), it does not
 * silently degrade.
 */
export function tryParseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // Strip ```json / ``` fences if present. Match only at boundaries so we
  // don't mangle JSON strings that legitimately contain backticks.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();

  // Tier 1: clean parse — fast path for fully compliant outputs.
  const tier1 = tryJsonParseObject(cleaned);
  if (tier1 !== undefined) return tier1;

  // Tier 2: scan forward to the FIRST `{` and parse from there. Recovers the
  // preamble-then-JSON pattern reasoning models emit. A backward scan from
  // the last `{` was considered but rejected: it silently returns the wrong
  // object when the prose contains a brace-bearing example after the real
  // payload (e.g. `{"actual":1}\nFor example: {"x":2}` would yield `{x:2}`),
  // breaking the conservative-failure contract callers rely on.
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace > 0) {
    const tier2 = tryJsonParseObject(cleaned.slice(firstBrace));
    if (tier2 !== undefined) return tier2;
  }

  // Tier 3: structural repair (jsonrepair) of the object region. Fixes the
  // failure modes the earlier tiers can't — trailing commas, single quotes,
  // unquoted keys, and the truncated tail of a `max_tokens`-cut response,
  // including a prose preamble before the object.
  //
  // Gated to a slice that starts at the first `{` AND contains a `:` (i.e.
  // something shaped like a key/value object). jsonrepair is aggressive enough
  // to turn comma-separated prose into an array and `{not valid` into
  // `{"not valid":null}`; the gate keeps that garbage out so the
  // conservative-failure contract holds (prose / brace-without-colon →
  // undefined). jsonrepair also throws on irreparable input, which we swallow.
  if (firstBrace >= 0) {
    const region = cleaned.slice(firstBrace);
    if (region.includes(':')) {
      try {
        // tryJsonParseObject is object-only, which matters most here: jsonrepair
        // turns `{valid}\ntrailing prose` into the array `[{valid}, "…"]`, and
        // rejecting non-objects keeps that bogus data out (degrade cleanly).
        const tier3 = tryJsonParseObject(jsonrepair(region));
        if (tier3 !== undefined) return tier3;
      } catch {
        /* irreparable — fall through to the undefined contract */
      }
    }
  }

  return undefined;
}

/**
 * Parse `text` as JSON and only return it if the result is a non-null, non-array
 * object. Schema augmentation always asks for an object and `output_format` is an
 * object schema — bare `null`, numbers, strings, AND top-level arrays parse
 * cleanly but are not valid structured output, so all of them are treated as
 * missing (returns `undefined`). Object-only across every tier keeps the contract
 * consistent and stops jsonrepair's prose→array coercion from leaking through.
 */
function tryJsonParseObject(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
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
 * can detect the case up front with {@link hasOpenAdditionalProperties}.
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

/**
 * True if any object node in `schema` declares `additionalProperties` as
 * something other than `false` — e.g. `additionalProperties: true` or an
 * open-record subschema like `additionalProperties: { type: 'string' }`.
 * {@link normalizeJsonSchemaForOpenAiStrict} silently rewrites these to `false`
 * for OpenAI strict-mode; the Codex provider uses this to warn the author that
 * their open-record semantics were dropped. Detection reuses the normalizer's
 * object-node rule, so it never flags a node the normalizer would leave
 * untouched. See issue #1843.
 */
export function hasOpenAdditionalProperties(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.some(hasOpenAdditionalProperties);
  }
  if (schema === null || typeof schema !== 'object') {
    return false;
  }
  const node = schema as Record<string, unknown>;
  if (
    isObjectSchemaNode(node) &&
    'additionalProperties' in node &&
    node.additionalProperties !== false
  ) {
    return true;
  }
  return Object.values(node).some(hasOpenAdditionalProperties);
}
