import {
  CONFIG_STRING_NORMALIZATION_KEY,
  configStringNormalizationSchema,
  normalizeConfigString,
} from '@archon/provider-contract';
import { z } from 'zod';

type JsonSchema = z.core.JSONSchema.BaseSchema | boolean;

function resolveConfigReference(
  node: JsonSchema,
  schema: z.core.JSONSchema.BaseSchema
): JsonSchema {
  if (typeof node !== 'object' || !node.$ref) return node;
  const referenced = node.$ref
    .split('/')
    .slice(1)
    .reduce<unknown>((value, key) => {
      if (value === null || typeof value !== 'object') return undefined;
      return Reflect.get(value, key.replaceAll('~1', '/').replaceAll('~0', '~'));
    }, schema);
  if (referenced === undefined) throw new Error(`Unresolved config schema reference ${node.$ref}`);
  return z.union([z.boolean(), z.record(z.string(), z.json())]).parse(referenced);
}

function resolveConfigSchema(node: JsonSchema, schema: z.core.JSONSchema.BaseSchema): JsonSchema {
  const resolved = resolveConfigReference(node, schema);
  return resolved === node ? node : resolveConfigSchema(resolved, schema);
}

interface Applicators {
  /** The referenced schema and every allOf member: all must hold. */
  conjuncts: JsonSchema[];
  /** One branch set per anyOf and oneOf keyword: each set must be satisfied. */
  alternatives: JsonSchema[][];
}

// The only reader of composition keywords. JSON Schema applies every present keyword,
// so a node with both anyOf and oneOf has two alternative sets, never one or the other.
function applicators(node: JsonSchema, schema: z.core.JSONSchema.BaseSchema): Applicators {
  if (typeof node !== 'object') return { conjuncts: [], alternatives: [] };
  return {
    conjuncts: [
      ...(node.$ref ? [resolveConfigReference(node, schema)] : []),
      ...(node.allOf ?? []),
    ],
    alternatives: [node.anyOf, node.oneOf].filter(set => set !== undefined),
  };
}

// Credential selection has only a model; root constraints and unrelated run fields
// belong to full configuration validation, not to this field projection.
export function modelConfigSchema(
  schema: z.core.JSONSchema.BaseSchema
): z.ZodType<{ model: string }> {
  const modelRule = (node: JsonSchema): z.core.JSONSchema.BaseSchema => {
    if (typeof node !== 'object') return node ? {} : { not: {} };
    const fields: JsonSchema[] = [];
    if (node.properties?.model !== undefined) fields.push(node.properties.model);
    for (const [pattern, rule] of Object.entries(node.patternProperties ?? {})) {
      if (new RegExp(pattern).test('model')) fields.push(rule);
    }
    if (fields.length === 0) fields.push(node.additionalProperties ?? true);
    const rules: z.core.JSONSchema.BaseSchema[] = fields.map(field =>
      typeof field === 'object' ? field : field ? {} : { not: {} }
    );
    const { conjuncts, alternatives } = applicators(node, schema);
    rules.push(...conjuncts.map(modelRule));
    // Distinct oneOf run branches can share a model rule once unrelated fields are removed.
    rules.push(...alternatives.map(set => ({ anyOf: set.map(modelRule) })));
    const constraints = rules.filter(rule => Object.keys(rule).length > 0);
    return constraints.length === 0
      ? {}
      : constraints.length === 1
        ? constraints[0]
        : { allOf: constraints };
  };
  const rule = modelRule(schema);
  const validator = (node: JsonSchema) =>
    z.fromJSONSchema(
      typeof node === 'object'
        ? { $defs: schema.$defs, definitions: schema.definitions, ...node }
        : node
    );
  // Validate every conjunct against the raw model before applying normalization.
  // Intersecting transformed outputs would conflict with identity-only rules.
  const normalize = (
    raw: string,
    node: JsonSchema,
    value: string | undefined
  ): string | undefined => {
    if (value === undefined || typeof node !== 'object') return value;
    const mode = node[CONFIG_STRING_NORMALIZATION_KEY];
    if (mode !== undefined)
      value = normalizeConfigString(value, configStringNormalizationSchema.parse(mode));
    const { conjuncts, alternatives } = applicators(node, schema);
    for (const conjunct of conjuncts) value = normalize(raw, conjunct, value);
    for (const set of alternatives) {
      // Unrelated run fields can select a different branch. A model alone is
      // sufficient only when every applicable branch gives the same result.
      const results = new Set(
        set
          .filter(candidate => validator(candidate).safeParse(raw).success)
          .map(branch => normalize(raw, branch, value))
      );
      if (results.size !== 1) return undefined;
      value = results.values().next().value;
    }
    return value;
  };
  return z.object({
    model: validator(rule)
      .pipe(z.string())
      .transform((value, ctx) => {
        const normalized = normalize(value, rule, value);
        if (normalized !== undefined) return normalized;
        ctx.addIssue({
          code: 'custom',
          message: 'Model normalization depends on other run settings',
        });
        return z.NEVER;
      }),
  });
}

export function scopedConfigSchema(
  schema: z.core.JSONSchema.BaseSchema,
  stripUnknownKeys: boolean,
  snapshot: boolean
): z.ZodType {
  const validator = z.fromJSONSchema(schema);
  const branchValidator = (branch: JsonSchema) =>
    z.fromJSONSchema(
      typeof branch === 'object'
        ? { $defs: schema.$defs, definitions: schema.definitions, ...branch }
        : branch
    );
  const selectedBranch = (value: unknown, branches: JsonSchema[], root: boolean) =>
    branches.find(
      branch => branchValidator(branch).safeParse(project(value, branch, root)).success
    );
  // Conjuncts share field ownership; alternatives contribute only their selected branch.
  const objectRules = (
    value: unknown,
    node: JsonSchema,
    root: boolean
  ): z.core.JSONSchema.BaseSchema[] => {
    if (typeof node !== 'object') return [];
    const { conjuncts, alternatives } = applicators(node, schema);
    const selected = alternatives
      .map(set => selectedBranch(value, set, root))
      .filter(branch => branch !== undefined);
    return [node, ...[...conjuncts, ...selected].flatMap(rule => objectRules(value, rule, root))];
  };
  const declaresKey = (rules: z.core.JSONSchema.BaseSchema[], key: string): boolean =>
    rules.some(
      node =>
        Object.hasOwn(node.properties ?? {}, key) ||
        Object.keys(node.patternProperties ?? {}).some(pattern => new RegExp(pattern).test(key)) ||
        node.additionalProperties === true ||
        typeof node.additionalProperties === 'object'
    );
  const project = (
    value: unknown,
    unresolved: JsonSchema,
    root = false,
    output = false,
    owners = objectRules(value, unresolved, root)
  ): unknown => {
    const node = unresolved;
    if (typeof node !== 'object') return value;
    const original = value;
    const { conjuncts, alternatives } = applicators(node, schema);
    for (const set of alternatives) {
      const branch = selectedBranch(original, set, root);
      if (branch !== undefined) value = project(value, branch, root, output, owners);
    }
    value = projectConjuncts(value, conjuncts, root, output, owners);
    const normalization = node[CONFIG_STRING_NORMALIZATION_KEY];
    if (output && typeof value === 'string' && normalization !== undefined) {
      return normalizeConfigString(value, configStringNormalizationSchema.parse(normalization));
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown, index) => {
        const itemSchema = node.prefixItems?.[index] ?? node.items;
        return itemSchema && !Array.isArray(itemSchema)
          ? project(item, itemSchema, false, output)
          : item;
      });
    }
    if (value === null || typeof value !== 'object') return value;
    return projectObject(value, node, root, output, owners);
  };
  const projectConjuncts = (
    value: unknown,
    conjuncts: JsonSchema[],
    root: boolean,
    output: boolean,
    owners: z.core.JSONSchema.BaseSchema[]
  ): unknown => {
    if (conjuncts.length === 0) return value;
    if (output) {
      for (const conjunct of conjuncts) value = project(value, conjunct, root, true, owners);
    } else {
      const members: z.ZodType[] = conjuncts.map(conjunct =>
        z.preprocess(
          input => project(input, conjunct, root, false, owners),
          branchValidator(conjunct)
        )
      );
      const parsed = members.reduce((left, right) => z.intersection(left, right)).safeParse(value);
      if (parsed.success) value = parsed.data;
    }
    return value;
  };
  const projectObject = (
    value: object,
    node: z.core.JSONSchema.BaseSchema,
    root: boolean,
    output: boolean,
    owners: z.core.JSONSchema.BaseSchema[]
  ): unknown => {
    const properties = node.properties ?? {};
    const patterns = Object.entries(node.patternProperties ?? {}).map(([pattern, child]) => ({
      pattern: new RegExp(pattern),
      child,
    }));
    const constrainedObject = owners.some(
      rule =>
        rule.properties !== undefined ||
        rule.patternProperties !== undefined ||
        rule.additionalProperties !== undefined
    );
    const strip =
      !output &&
      constrainedObject &&
      ((root && snapshot && node.additionalProperties !== false) ||
        (stripUnknownKeys && node.additionalProperties === undefined));
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, field]) => {
        const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (property !== undefined) {
          const resolved = resolveConfigSchema(property, schema);
          if (
            output &&
            root &&
            snapshot &&
            typeof resolved === 'object' &&
            resolved.writeOnly === true
          )
            return [];
          return [
            [
              key,
              patterns
                .filter(({ pattern }) => pattern.test(key))
                .reduce(
                  (projected, { child }) => project(projected, child, false, output),
                  project(field, property, false, output)
                ),
            ],
          ];
        }
        const matching = patterns.filter(({ pattern }) => pattern.test(key));
        if (matching.length > 0)
          return [
            [
              key,
              matching.reduce(
                (projected, { child }) => project(projected, child, false, output),
                field
              ),
            ],
          ];
        if (typeof node.additionalProperties === 'object')
          return [[key, project(field, node.additionalProperties, false, output)]];
        return strip && !declaresKey(owners, key) ? [] : [[key, field]];
      })
    );
  };
  return z
    .preprocess(value => project(value, schema, true), validator)
    .transform(value => project(value, schema, true, true));
}
