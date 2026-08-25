import { mergeTokenUsage, type TokenUsage } from '../../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeTokens(info: Record<string, unknown> | undefined): TokenUsage | undefined {
  const tokens = isRecord(info?.tokens) ? info.tokens : undefined;
  if (!tokens) return undefined;

  const input = typeof tokens.input === 'number' ? tokens.input : 0;
  const output = typeof tokens.output === 'number' ? tokens.output : 0;
  const reasoning = typeof tokens.reasoning === 'number' ? tokens.reasoning : 0;
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const cacheRead = typeof cache?.read === 'number' ? cache.read : undefined;
  const cacheWrite = typeof cache?.write === 'number' ? cache.write : undefined;
  const grossInput = input + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const total = grossInput + output + reasoning;

  return {
    input: grossInput,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(total > 0 ? { total } : {}),
    ...(typeof info?.cost === 'number' ? { cost: info.cost } : {}),
  };
}

/** Aggregate the final update for every assistant message in one OpenCode session. */
export function aggregateAssistantMessageUsage(
  messages: Iterable<Record<string, unknown>>
): TokenUsage | undefined {
  const infos = [...messages];
  const usages = infos
    .map(info => normalizeTokens(info))
    .filter((usage): usage is TokenUsage => usage !== undefined);
  const merged = mergeTokenUsage(usages);
  if (merged === undefined) return undefined;

  const cost =
    usages.length === infos.length &&
    usages.every(
      usage => typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0
    )
      ? usages.reduce((sum, usage) => sum + (usage.cost ?? 0), 0)
      : undefined;
  const total = usages.reduce((sum, usage) => sum + (usage.total ?? usage.input + usage.output), 0);
  return {
    ...merged,
    ...(total > 0 ? { total } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}
