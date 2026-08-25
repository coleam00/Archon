import { InvalidProviderRunConfigError } from '../errors';

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

export function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
