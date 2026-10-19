import { mergeTokenUsage, type TokenUsage } from '../../types';

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

/**
 * Usage of one prompt, summed over its assistant messages. OpenCode records each model step
 * as its own assistant message, so a prompt that calls a tool spans several, each priced
 * separately. Tokens stay unknown when any message's tokens do not normalize, rather than
 * becoming a silent floor; a single message passes through unchanged.
 */
export function sumAssistantUsage(infos: readonly Record<string, unknown>[]): {
  tokens?: TokenUsage;
  cost?: number;
} {
  const costs = infos.flatMap(info => (typeof info.cost === 'number' ? [info.cost] : []));
  const cost = costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : undefined;
  const usages = infos.map(normalizeTokens);
  if (usages.length === 0 || !usages.every(usage => usage !== undefined)) return { cost };
  if (usages.length === 1) return { tokens: usages[0], cost };
  const merged = mergeTokenUsage(usages);
  if (merged === undefined) return { cost };
  const totals = usages.flatMap(usage => (usage.total !== undefined ? [usage.total] : []));
  return {
    tokens: {
      ...merged,
      ...(totals.length === usages.length
        ? { total: totals.reduce((sum, value) => sum + value, 0) }
        : {}),
      ...(cost !== undefined ? { cost } : {}),
    },
    cost,
  };
}
