import type { TokenUsage } from '../../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeTokens(info: Record<string, unknown> | undefined): TokenUsage | undefined {
  const tokens = isRecord(info?.tokens) ? info.tokens : undefined;
  if (!tokens) return undefined;

  const input = typeof tokens.input === 'number' ? tokens.input : undefined;
  const output = typeof tokens.output === 'number' ? tokens.output : undefined;
  if (input === undefined || output === undefined) return undefined;

  const reasoning = typeof tokens.reasoning === 'number' ? tokens.reasoning : undefined;
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const cacheRead = typeof cache?.read === 'number' ? cache.read : undefined;
  const cacheWrite = typeof cache?.write === 'number' ? cache.write : undefined;
  const grossInput = input + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const totalComplete =
    reasoning !== undefined && cacheRead !== undefined && cacheWrite !== undefined;

  return {
    input: grossInput,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(totalComplete ? { total: grossInput + output + reasoning } : {}),
    ...(typeof info?.cost === 'number' ? { cost: info.cost } : {}),
  };
}
