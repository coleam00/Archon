import { z } from 'zod';
import { InvalidProviderRunConfigError, normalizedConfigString } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('provider.config');
  return cachedLog;
}

export const configStringSchema = normalizedConfigString(
  z.string().regex(/\S/, 'expected a non-blank string'),
  'trim'
);

export function parseConfigSchema<T extends z.ZodType>(
  schema: T,
  raw: Record<string, unknown>
): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = [
      ...issue.path,
      ...(issue.code === 'unrecognized_keys' ? [issue.keys[0]] : []),
    ].join('.');
    throw new InvalidProviderRunConfigError(
      path,
      issue.code === 'unrecognized_keys' ? 'unknown provider setting' : issue.message
    );
  }
  return parsed.data;
}

type ConfigPath = readonly PropertyKey[];

/** Deeper paths first, and higher array indices first, so a removal never shifts a later one. */
function compareRemovalOrder(a: ConfigPath, b: ConfigPath): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (x === y) continue;
    return typeof x === 'number' && typeof y === 'number' ? y - x : String(x) < String(y) ? -1 : 1;
  }
  return b.length - a.length;
}

function removeAt(root: unknown, path: ConfigPath): boolean {
  let parent = root;
  for (const key of path.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object') return false;
    parent = (parent as Record<PropertyKey, unknown>)[key];
  }
  const last = path.at(-1);
  if (
    last === undefined ||
    parent === null ||
    typeof parent !== 'object' ||
    !Object.hasOwn(parent, last)
  )
    return false;
  if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else delete (parent as Record<PropertyKey, unknown>)[last];
  return true;
}

/**
 * Runtime counterpart of `parseConfigSchema`: removes every value the schema
 * rejects (an unknown key, a field, one array element or record entry) and
 * parses what remains, so broken user config cannot block provider
 * registration or workflow discovery. Strict parsing at config load is where
 * the operator hears why a value is wrong; this only logs the dropped paths,
 * never their values.
 *
 * The schema's fields must all be optional: input that cannot be pruned into
 * a valid shape falls back to `schema.parse({})`.
 */
export function parseConfigLenient<T extends z.ZodType>(
  schema: T,
  raw: Record<string, unknown>,
  provider: string
): z.output<T> {
  const dropped: string[] = [];
  const data = pruneToSchema(schema, structuredClone(raw), dropped);
  if (dropped.length > 0) {
    getLog().warn({ provider, fields: dropped }, 'provider.config_invalid_fields_dropped');
  }
  return data;
}

function pruneToSchema<T extends z.ZodType>(
  schema: T,
  value: unknown,
  dropped: string[]
): z.output<T> {
  for (;;) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const paths = parsed.error.issues.flatMap(issue =>
      issue.code === 'unrecognized_keys'
        ? issue.keys.map(key => [...issue.path, key])
        : [issue.path]
    );
    const removed = paths.sort(compareRemovalOrder).filter(path => removeAt(value, path));
    dropped.push(...removed.map(path => path.map(String).join('.')));
    if (removed.length === 0) {
      dropped.push('<all>');
      return schema.parse({});
    }
  }
}
