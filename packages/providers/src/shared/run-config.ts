import { z } from 'zod';
import { InvalidProviderRunConfigError } from '@archon/provider-contract';

export function assertKnownRunConfigKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const unknown = Object.keys(raw).find(key => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new InvalidProviderRunConfigError(unknown, 'unknown provider setting');
  }
}

export function invalidRunConfigValue(fieldPath: string, expected: string): never {
  throw new InvalidProviderRunConfigError(fieldPath, `expected ${expected}`);
}

export function normalizeRunConfigString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidRunConfigValue(fieldPath, 'a non-blank string');
  }
  return value.trim();
}

export const configStringSchema = z.string().regex(/\S/, 'expected a non-blank string');

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
