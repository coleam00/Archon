import { validateStructuredOutput } from './structured-output';

type StringDomain = 'all' | 'unknown' | ReadonlySet<string>;
const noStrings: StringDomain = new Set<string>();

function intersect(left: StringDomain, right: StringDomain): StringDomain {
  if (left === 'all') return right;
  if (right === 'all') return left;
  if (left === 'unknown') return right;
  if (right === 'unknown') return left;
  return new Set([...left].filter(value => right.has(value)));
}

function union(left: StringDomain, right: StringDomain): StringDomain {
  if (left === 'all' || right === 'all') return 'all';
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  return new Set([...left, ...right]);
}

function complement(domain: StringDomain): StringDomain {
  if (domain === 'all') return noStrings;
  if (typeof domain !== 'string' && domain.size === 0) return 'all';
  return 'unknown';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Upper bound on the schema's strings. 'all' also proves every string is valid;
 * 'unknown' cannot be complemented. String constraints stay with AJV, which
 * checks finite candidates against the complete schema rather than sampled text.
 */
function stringDomain(
  raw: unknown,
  root: Record<string, unknown> | undefined,
  visiting: ReadonlySet<unknown> = new Set()
): StringDomain {
  if (raw === false) return noStrings;
  if (raw === true) return 'all';
  const schema = record(raw);
  if (!schema || visiting.has(schema)) return 'unknown';
  if (schema !== root && schema.$id !== undefined) root = undefined;
  const next = new Set([...visiting, schema]);
  let domain: StringDomain = 'all';
  const type = schema.type;
  if (
    type !== undefined &&
    type !== 'string' &&
    !(Array.isArray(type) && type.includes('string'))
  ) {
    return noStrings;
  }
  if ('const' in schema) {
    domain = typeof schema.const === 'string' ? new Set([schema.const]) : noStrings;
  }
  if (Array.isArray(schema.enum)) {
    domain = intersect(
      domain,
      new Set(schema.enum.filter((value): value is string => typeof value === 'string'))
    );
  }
  if (schema.$ref !== undefined) {
    let target: unknown = root;
    let resource = root;
    if (root !== undefined && schema.$ref === '#') {
      domain = intersect(domain, stringDomain(target, resource, next));
    } else if (
      root !== undefined &&
      typeof schema.$ref === 'string' &&
      schema.$ref.startsWith('#/')
    ) {
      for (const part of decodeURIComponent(schema.$ref.slice(2)).split('/')) {
        target = record(target)?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
        const targetSchema = record(target);
        if (targetSchema?.$id !== undefined) resource = undefined;
      }
      domain = intersect(domain, stringDomain(target, resource, next));
    } else {
      // Nested resource IDs and non-pointer references need URI resolution.
      // Without that proof, their string domain stays unknown.
      domain = intersect(domain, 'unknown');
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) domain = intersect(domain, stringDomain(branch, root, next));
  }
  if (Array.isArray(schema.anyOf)) {
    domain = intersect(
      domain,
      schema.anyOf.map(branch => stringDomain(branch, root, next)).reduce(union, noStrings)
    );
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map(branch => stringDomain(branch, root, next));
    const universal = branches.filter(branch => branch === 'all').length;
    const alternatives = branches.reduce(union, noStrings);
    const exclusive =
      universal > 1
        ? noStrings
        : universal === 1 &&
            branches.some(
              branch => branch === 'unknown' || (typeof branch !== 'string' && branch.size > 0)
            )
          ? 'unknown'
          : alternatives;
    domain = intersect(domain, exclusive);
  }
  if (schema.not !== undefined)
    domain = intersect(domain, complement(stringDomain(schema.not, root, next)));
  if (schema.if !== undefined) {
    const condition = stringDomain(schema.if, root, next);
    const thenDomain = stringDomain(schema.then ?? true, root, next);
    const elseDomain = stringDomain(schema.else ?? true, root, next);
    domain = intersect(
      domain,
      union(intersect(condition, thenDomain), intersect(complement(condition), elseDomain))
    );
  }
  if (['minLength', 'maxLength', 'pattern', 'format'].some(key => key in schema)) {
    domain = intersect(domain, 'unknown');
  }
  return domain;
}

export function outputSchemaExcludesStrings(schema: Record<string, unknown>): boolean {
  const domain = stringDomain(schema, schema);
  return (
    typeof domain !== 'string' &&
    [...domain].every(value => !validateStructuredOutput(value, schema).valid)
  );
}
