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

// Credential selection has only a model; root constraints and unrelated run fields
// belong to full configuration validation, not to this field projection.
export function modelConfigSchema(
  schema: z.core.JSONSchema.BaseSchema
): z.ZodType<{ model: string }> {
  const modelRule = (node: JsonSchema): z.core.JSONSchema.BaseSchema => {
    if (typeof node !== 'object') return node ? {} : { not: {} };
    const field = node.properties?.model ?? true;
    const rules: z.core.JSONSchema.BaseSchema[] = [
      typeof field === 'object' ? field : field ? {} : { not: {} },
    ];
    if (node.$ref) rules.push(modelRule(resolveConfigReference(node, schema)));
    if (node.anyOf) rules.push({ anyOf: node.anyOf.map(modelRule) });
    // Distinct run branches can share a model rule once unrelated fields are removed.
    if (node.oneOf) rules.push({ anyOf: node.oneOf.map(modelRule) });
    if (node.allOf) rules.push(...node.allOf.map(modelRule));
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
  const normalize = (raw: string, node: JsonSchema, value = raw): string => {
    if (typeof node !== 'object') return value;
    const mode = node[CONFIG_STRING_NORMALIZATION_KEY];
    if (mode !== undefined)
      value = normalizeConfigString(value, configStringNormalizationSchema.parse(mode));
    if (node.$ref) value = normalize(raw, resolveConfigReference(node, schema), value);
    const branches = node.anyOf ?? node.oneOf;
    if (branches) {
      const branch = branches.find(candidate => validator(candidate).safeParse(raw).success);
      if (branch !== undefined) value = normalize(raw, branch, value);
    }
    for (const branch of node.allOf ?? []) value = normalize(raw, branch, value);
    return value;
  };
  return z.object({
    model: validator(rule)
      .pipe(z.string())
      .transform(value => normalize(value, rule)),
  });
}

export function scopedConfigSchema(
  schema: z.core.JSONSchema.BaseSchema,
  stripUnknownKeys: boolean,
  snapshot: boolean
): z.ZodType {
  const validator = z.fromJSONSchema(schema);
  const project = (
    value: unknown,
    unresolved: JsonSchema,
    root = false,
    output = false
  ): unknown => {
    const node = resolveConfigSchema(unresolved, schema);
    if (typeof node !== 'object') return value;
    const normalization = node[CONFIG_STRING_NORMALIZATION_KEY];
    if (output && typeof value === 'string' && normalization !== undefined) {
      return normalizeConfigString(value, configStringNormalizationSchema.parse(normalization));
    }
    const branches = node.anyOf ?? node.oneOf;
    if (branches) {
      for (const branch of branches) {
        const projected = project(value, branch, root);
        if (
          z
            .fromJSONSchema({ $defs: schema.$defs, definitions: schema.definitions, ...branch })
            .safeParse(projected).success
        )
          return output ? project(projected, branch, root, true) : projected;
      }
      return value;
    }
    if (node.allOf?.length) {
      const members: z.ZodType[] = node.allOf.map(branch =>
        z.preprocess(
          input => project(input, branch, root, output),
          z.fromJSONSchema({ $defs: schema.$defs, definitions: schema.definitions, ...branch })
        )
      );
      const intersection = members.reduce((left, right) => z.intersection(left, right));
      const parsed = intersection.safeParse(value);
      return parsed.success ? parsed.data : value;
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown, index) => {
        const itemSchema = node.prefixItems?.[index] ?? node.items;
        return itemSchema && !Array.isArray(itemSchema)
          ? project(item, itemSchema, false, output)
          : item;
      });
    }
    if (value === null || typeof value !== 'object' || node.type !== 'object') return value;
    const properties = node.properties ?? {};
    const patterns = Object.entries(node.patternProperties ?? {}).map(([pattern, child]) => ({
      pattern: new RegExp(pattern),
      child,
    }));
    const strip =
      (root && snapshot && node.additionalProperties !== false) ||
      (stripUnknownKeys && node.additionalProperties === undefined);
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
          return [[key, project(field, property, false, output)]];
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
        return strip ? [] : [[key, field]];
      })
    );
  };
  return z
    .preprocess(value => project(value, schema, true), validator)
    .transform(value => project(value, schema, true, true));
}
