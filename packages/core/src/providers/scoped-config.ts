import { z } from 'zod';

type JsonSchema = z.core.JSONSchema.BaseSchema | boolean;

export function scopedConfigSchema(
  schema: z.core.JSONSchema.BaseSchema,
  stripUnknownKeys: boolean,
  snapshot: boolean
): z.ZodType {
  const validator = z.fromJSONSchema(schema);
  const resolve = (node: JsonSchema): JsonSchema => {
    if (typeof node !== 'object' || !node.$ref) return node;
    const referenced = node.$ref
      .split('/')
      .slice(1)
      .reduce<unknown>((value, key) => {
        if (value === null || typeof value !== 'object') return undefined;
        return Reflect.get(value, key.replaceAll('~1', '/').replaceAll('~0', '~'));
      }, schema);
    if (referenced === undefined)
      throw new Error(`Unresolved config schema reference ${node.$ref}`);
    return resolve(z.union([z.boolean(), z.record(z.string(), z.json())]).parse(referenced));
  };
  const project = (value: unknown, unresolved: JsonSchema, root = false): unknown => {
    const node = resolve(unresolved);
    if (typeof node !== 'object') return value;
    const branches = node.anyOf ?? node.oneOf;
    if (branches) {
      for (const branch of branches) {
        const projected = project(value, branch, root);
        if (
          z
            .fromJSONSchema({ $defs: schema.$defs, definitions: schema.definitions, ...branch })
            .safeParse(projected).success
        )
          return projected;
      }
      return value;
    }
    if (node.allOf?.length) {
      const members: z.ZodType[] = node.allOf.map(branch =>
        z.preprocess(
          input => project(input, branch, root),
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
        return itemSchema && !Array.isArray(itemSchema) ? project(item, itemSchema) : item;
      });
    }
    if (value === null || typeof value !== 'object' || node.type !== 'object') return value;
    const properties = node.properties ?? {};
    const patterns = Object.entries(node.patternProperties ?? {}).map(([pattern, child]) => ({
      pattern: new RegExp(pattern),
      child,
    }));
    const strip =
      (root && snapshot) || (stripUnknownKeys && node.additionalProperties === undefined);
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, field]) => {
        const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (property !== undefined) return [[key, project(field, property)]];
        const matching = patterns.filter(({ pattern }) => pattern.test(key));
        if (matching.length > 0)
          return [
            [key, matching.reduce((projected, { child }) => project(projected, child), field)],
          ];
        if (typeof node.additionalProperties === 'object')
          return [[key, project(field, node.additionalProperties)]];
        return strip ? [] : [[key, field]];
      })
    );
  };
  return z.preprocess(value => project(value, schema, true), validator);
}
