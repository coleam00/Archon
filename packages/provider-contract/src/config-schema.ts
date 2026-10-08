import { z } from 'zod';

export const CONFIG_STRING_NORMALIZATION_KEY = 'x-archon-normalize';
export const configStringNormalizationSchema = z.enum(['trim', 'slash-separated']);
type ConfigStringNormalization = z.infer<typeof configStringNormalizationSchema>;

export function normalizeConfigString(value: string, mode: ConfigStringNormalization): string {
  if (mode === 'trim') return value.trim();
  const slash = value.indexOf('/');
  return slash < 0
    ? value.trim()
    : `${value.slice(0, slash).trim()}/${value.slice(slash + 1).trim()}`;
}

// JSON Schema has no string transforms. This annotation carries the same operation
// as the Zod transform so process-backed configuration has identical canonical values.
export function normalizedConfigString(
  schema: z.ZodString,
  mode: ConfigStringNormalization
): z.ZodType<string, string> {
  return schema
    .transform(value => normalizeConfigString(value, mode))
    .meta({ [CONFIG_STRING_NORMALIZATION_KEY]: mode });
}

export function snapshotConfigSchema<P extends Record<string, z.ZodType>>(
  portable: P,
  local: Record<string, z.ZodType>
): z.ZodType<z.output<z.ZodObject<P>>> {
  const output = z.strictObject(portable);
  const fields = Object.fromEntries(
    Object.entries(local).map(([key, field]) => [key, field.meta({ writeOnly: true })])
  );
  return z
    .strictObject({ ...portable, ...fields })
    .transform(value =>
      output.parse(
        Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(portable, key)))
      )
    );
}
