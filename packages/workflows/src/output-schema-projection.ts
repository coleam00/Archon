import { isDeepStrictEqual } from 'node:util';

export const COMPOSITION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'] as const;

interface PropertyConstraints {
  required: boolean;
  constants: unknown[];
}

interface AncestorConstraints {
  types: string[] | undefined;
  properties: ReadonlyMap<string, PropertyConstraints>;
}

interface PathAlternative {
  checks: boolean[];
  ancestors: AncestorConstraints[];
}

function conjunctivePropertyPaths(
  schema: unknown,
  prefix: string[],
  shared: Set<string>
): Set<string> {
  const object = asPlainObject(schema);
  const direct = new Set<string>();
  Object.entries(asPlainObject(object?.properties) ?? {}).forEach(([key, child]) => {
    const path = [...prefix, key];
    if (Object.hasOwn(asPlainObject(child) ?? {}, 'const')) direct.add(JSON.stringify(path));
    conjunctivePropertyPaths(child, path, shared).forEach(nested => direct.add(nested));
  });
  requiredProperties(object).forEach(key => direct.add(JSON.stringify([...prefix, key])));
  const groups = [direct];
  for (const keyword of COMPOSITION_KEYWORDS) {
    const branches = object?.[keyword];
    if (!Array.isArray(branches)) continue;
    const paths = branches.map(branch => conjunctivePropertyPaths(branch, prefix, shared));
    if (keyword === 'allOf') groups.push(...paths);
    else groups.push(new Set(paths.flatMap(group => [...group])));
  }
  return markSharedPaths(groups, shared);
}

function markSharedPaths(groups: Set<string>[], shared: Set<string>): Set<string> {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const key of group) {
      if (seen.has(key)) shared.add(key);
      seen.add(key);
    }
  }
  return seen;
}

function schemaTypes(schema: Record<string, unknown>): string[] | undefined {
  const type = schema.type;
  if (type === undefined) return undefined;
  const types: unknown[] = typeof type === 'string' ? [type] : Array.isArray(type) ? type : [];
  return types.flatMap(value =>
    typeof value !== 'string' ? [] : value === 'number' ? ['number', 'integer'] : [value]
  );
}

/** Each entry is a conjunction of declarations; entries are selectable alternatives.
 * An empty conjunction leaves the path unconstrained, while no alternatives means false.
 * Ancestor constraints discard impossible branches before projection. Only property constraints
 * shared across conjuncts need retaining; independent choices must not multiply the projection.
 * The caller classifies declarations as satisfying, incompatible, or annotation-only (undefined),
 * so annotations and other differences irrelevant to its decision never multiply alternatives.
 */
export function outputSchemaAlternativesForPath(
  schema: unknown,
  path: readonly string[],
  classify: (schema: unknown) => boolean | undefined
): boolean[][] {
  const shared = new Set<string>();
  conjunctivePropertyPaths(schema, [], shared);
  const unique = (alternatives: PathAlternative[]): PathAlternative[] => {
    const byConstraint = new Map<string, PathAlternative>();
    for (const alternative of alternatives) {
      const checks = [...new Set(alternative.checks)].sort();
      const key = JSON.stringify([
        alternative.ancestors.map(ancestor => ({
          ...ancestor,
          types: ancestor.types?.slice().sort(),
          properties: [...ancestor.properties].sort(([a], [b]) => a.localeCompare(b)),
        })),
        [...checks.keys()].sort(),
      ]);
      byConstraint.set(key, { ...alternative, checks: [...checks.values()] });
    }
    return [...byConstraint.values()];
  };
  const conjoin = (left: PathAlternative[], right: PathAlternative[]): PathAlternative[] => {
    const combined: PathAlternative[] = [];
    for (const a of left) {
      for (const b of right) {
        const ancestors = a.ancestors.map((ancestor, depth) => {
          const other = b.ancestors[depth];
          const types =
            ancestor.types === undefined
              ? other?.types
              : other?.types === undefined
                ? ancestor.types
                : ancestor.types.filter(type => other.types?.includes(type));
          const properties = new Map(ancestor.properties);
          for (const [key, constraint] of other?.properties ?? []) {
            const prior = properties.get(key);
            properties.set(key, {
              required: constraint.required || prior?.required === true,
              constants: [...(prior?.constants ?? []), ...constraint.constants].filter(
                (value, index, values) =>
                  values.findIndex(other => isDeepStrictEqual(value, other)) === index
              ),
            });
          }
          const conflicting = [...properties.values()].some(
            value => value.required && value.constants.length > 1
          );
          return {
            types: conflicting && types?.every(type => type === 'object') ? [] : types,
            properties,
          };
        });
        if (ancestors.some(ancestor => ancestor.types?.length === 0)) continue;
        combined.push({ checks: [...a.checks, ...b.checks], ancestors });
      }
    }
    return unique(combined);
  };
  const visit = (current: unknown, remaining: readonly string[]): PathAlternative[] => {
    if (remaining.length === 0) {
      const projected = classify(current);
      return [{ checks: projected === undefined ? [] : [projected], ancestors: [] }];
    }
    if (current === false) return [];
    const object = asPlainObject(current);
    const [key, ...rest] = remaining;
    const properties = asPlainObject(object?.properties);
    const children =
      properties !== undefined && key !== undefined && Object.hasOwn(properties, key)
        ? visit(properties[key], rest)
        : [
            {
              checks: [],
              ancestors: rest.map(() => ({
                types: undefined,
                properties: new Map<string, PropertyConstraints>(),
              })),
            },
          ];
    const ancestor = ancestorConstraints(
      object,
      path.slice(0, path.length - remaining.length),
      shared
    );
    let alternatives = children.map(child => ({
      checks: child.checks,
      ancestors: [ancestor, ...child.ancestors],
    }));
    for (const keyword of COMPOSITION_KEYWORDS) {
      const branches = object?.[keyword];
      if (!Array.isArray(branches)) continue;
      if (keyword === 'allOf') {
        for (const branch of branches)
          alternatives = conjoin(alternatives, visit(branch, remaining));
      } else {
        alternatives = conjoin(
          alternatives,
          unique(branches.flatMap(branch => visit(branch, remaining)))
        );
      }
    }
    return alternatives;
  };
  return visit(schema, path).map(alternative => alternative.checks);
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredProperties(schema: Record<string, unknown> | undefined): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
}

function ancestorConstraints(
  schema: Record<string, unknown> | undefined,
  prefix: readonly string[],
  shared: ReadonlySet<string>
): AncestorConstraints {
  const properties = asPlainObject(schema?.properties);
  const required = requiredProperties(schema);
  const constraints = new Map<string, PropertyConstraints>();
  for (const name of new Set([...Object.keys(properties ?? {}), ...required])) {
    if (!shared.has(JSON.stringify([...prefix, name]))) continue;
    const property = asPlainObject(properties?.[name]);
    constraints.set(name, {
      required: required.includes(name),
      constants: property !== undefined && Object.hasOwn(property, 'const') ? [property.const] : [],
    });
  }
  return { types: schema === undefined ? undefined : schemaTypes(schema), properties: constraints };
}
