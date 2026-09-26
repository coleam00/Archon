/** Provider-native Claude plan signals retained for independent direct-chat turns. */
export interface ProviderCooldown {
  provider: 'claude';
  resetAt: number;
  rateLimitType?: string;
}

export interface ProviderUsageWarning {
  provider: 'claude';
  resetAt: number;
  rateLimitType: string;
}

type StoredCooldown = ProviderCooldown & {
  rateLimitType?: string;
  scope: string;
};
type StoredUsageWarning = ProviderUsageWarning & { scope: string };

const MAX_PROVIDER_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
const MAX_COOLDOWN_ENTRIES = 10_000;
const cooldowns = new Map<string, StoredCooldown>();
const usageWarnings = new Map<string, StoredUsageWarning>();
const CLAUDE_MODEL_RATE_LIMIT_TYPES = new Set(['seven_day_opus', 'seven_day_sonnet']);
const CLAUDE_RATE_LIMIT_TYPES = new Set([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
]);

function cooldownKey(provider: string, scope: string, rateLimitType?: string): string {
  return JSON.stringify([provider, scope, rateLimitType ?? null]);
}

function usageWarningKey(provider: string, scope: string, rateLimitType: string): string {
  return JSON.stringify([provider, scope, rateLimitType]);
}

function toPublicUsageWarning(warning: StoredUsageWarning): ProviderUsageWarning {
  return {
    provider: warning.provider,
    resetAt: warning.resetAt,
    rateLimitType: warning.rateLimitType,
  };
}

function toPublicCooldown(cooldown: StoredCooldown): ProviderCooldown {
  return {
    provider: cooldown.provider,
    resetAt: cooldown.resetAt,
    ...(cooldown.rateLimitType ? { rateLimitType: cooldown.rateLimitType } : {}),
  };
}

function discardExpired(now: number): void {
  for (const [key, cooldown] of cooldowns) {
    if (cooldown.resetAt <= now) cooldowns.delete(key);
  }
  for (const [key, warning] of usageWarnings) {
    if (warning.resetAt <= now) usageWarnings.delete(key);
  }
}

function getValidResetAt(rateLimitInfo: Record<string, unknown>, now: number): number | undefined {
  const resetAtSeconds = rateLimitInfo.resetsAt;
  const nowSeconds = Math.floor(now / 1_000);
  if (
    typeof resetAtSeconds !== 'number' ||
    !Number.isSafeInteger(resetAtSeconds) ||
    resetAtSeconds <= nowSeconds ||
    resetAtSeconds - nowSeconds > MAX_PROVIDER_COOLDOWN_SECONDS
  ) {
    return undefined;
  }
  const resetAt = resetAtSeconds * 1_000;
  return Number.isSafeInteger(resetAt) ? resetAt : undefined;
}

function getActiveCooldown(key: string, now: number): StoredCooldown | undefined {
  const cooldown = cooldowns.get(key);
  if (!cooldown) return undefined;
  if (cooldown.resetAt <= now) {
    cooldowns.delete(key);
    return undefined;
  }
  return cooldown;
}

function getModelSpecificRateLimitType(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const normalizedModel = model.toLowerCase();
  if (/(?:^|[-_/])opus(?:$|[-_/])/.test(normalizedModel)) {
    return 'seven_day_opus';
  }
  if (/(?:^|[-_/])sonnet(?:$|[-_/])/.test(normalizedModel)) {
    return 'seven_day_sonnet';
  }
  return undefined;
}

/**
 * Record only Claude's SDK-native rejected rate-limit event with a valid
 * provider-supplied epoch-seconds reset timestamp. Other provider payloads and
 * local token/cost usage are not interpreted. The SDK declaration does not
 * specify timestamp units; observed provider payloads use epoch seconds, so
 * ambiguous millisecond values fail closed.
 */
export function recordProviderCooldown(
  provider: string,
  scope: string,
  rateLimitInfo: Record<string, unknown>,
  now = Date.now()
): ProviderCooldown | undefined {
  const overageIsUsable =
    rateLimitInfo.overageStatus === 'allowed' || rateLimitInfo.overageStatus === 'allowed_warning';
  if (provider !== 'claude') {
    return undefined;
  }

  const rateLimitType = rateLimitInfo.rateLimitType;
  const knownRateLimitType =
    typeof rateLimitType === 'string' && CLAUDE_RATE_LIMIT_TYPES.has(rateLimitType)
      ? rateLimitType
      : undefined;
  const modelSpecificRateLimitType =
    knownRateLimitType && CLAUDE_MODEL_RATE_LIMIT_TYPES.has(knownRateLimitType)
      ? knownRateLimitType
      : undefined;
  const key = cooldownKey(provider, scope, modelSpecificRateLimitType);
  if (rateLimitInfo.status !== 'rejected' || overageIsUsable) {
    if (overageIsUsable && knownRateLimitType) {
      if (cooldowns.get(key)?.rateLimitType === knownRateLimitType) {
        cooldowns.delete(key);
      }
    }
    return undefined;
  }

  const resetAt = getValidResetAt(rateLimitInfo, now);
  if (resetAt === undefined) return undefined;

  discardExpired(now);
  if (!cooldowns.has(key) && cooldowns.size >= MAX_COOLDOWN_ENTRIES) return undefined;

  for (const [warningKey, warning] of usageWarnings) {
    if (
      warning.provider === provider &&
      warning.scope === scope &&
      (!knownRateLimitType || warning.rateLimitType === knownRateLimitType)
    ) {
      usageWarnings.delete(warningKey);
    }
  }
  cooldowns.set(key, {
    provider: 'claude',
    resetAt,
    scope,
    ...(knownRateLimitType ? { rateLimitType: knownRateLimitType } : {}),
  });
  return {
    provider: 'claude',
    resetAt,
    ...(knownRateLimitType ? { rateLimitType: knownRateLimitType } : {}),
  };
}

/**
 * Record a provider-native Claude subscription warning. Utilization is
 * intentionally ignored because the SDK does not define its unit scale.
 * Only an explicit per-route policy may use this warning to choose a fallback.
 */
export function recordProviderUsageWarning(
  provider: string,
  scope: string,
  rateLimitInfo: Record<string, unknown>,
  now = Date.now()
): ProviderUsageWarning | undefined {
  if (provider !== 'claude') return undefined;

  const rateLimitType = rateLimitInfo.rateLimitType;
  if (typeof rateLimitType !== 'string' || !CLAUDE_RATE_LIMIT_TYPES.has(rateLimitType)) {
    return undefined;
  }
  const key = usageWarningKey(provider, scope, rateLimitType);
  const cooldownType = CLAUDE_MODEL_RATE_LIMIT_TYPES.has(rateLimitType) ? rateLimitType : undefined;
  const matchingCooldownKey = cooldownKey(provider, scope, cooldownType);
  if (rateLimitInfo.status === 'allowed') {
    usageWarnings.delete(key);
    const cooldown = cooldowns.get(matchingCooldownKey);
    if (cooldown?.rateLimitType === rateLimitType) {
      cooldowns.delete(matchingCooldownKey);
    }
    return undefined;
  }
  if (rateLimitInfo.status !== 'allowed_warning') return undefined;

  const resetAt = getValidResetAt(rateLimitInfo, now);
  if (resetAt === undefined) return undefined;

  discardExpired(now);
  if (cooldowns.get(matchingCooldownKey)?.rateLimitType === rateLimitType) {
    cooldowns.delete(matchingCooldownKey);
  }
  if (!usageWarnings.has(key) && usageWarnings.size >= MAX_COOLDOWN_ENTRIES) {
    return undefined;
  }
  const warning: StoredUsageWarning = {
    provider: 'claude',
    resetAt,
    scope,
    rateLimitType,
  };
  usageWarnings.set(key, warning);
  return toPublicUsageWarning(warning);
}

/** Return an active cooldown for one provider and scope, lazily removing expiry. */
export function getProviderCooldown(
  provider: string,
  scope: string,
  now = Date.now()
): ProviderCooldown | undefined {
  const key = cooldownKey(provider, scope);
  const cooldown = getActiveCooldown(key, now);
  if (!cooldown) return undefined;
  return toPublicCooldown(cooldown);
}

/** Return a shared or model-matching cooldown for one direct-chat candidate. */
export function getProviderCooldownForModel(
  provider: string,
  scope: string,
  model: string | undefined,
  now = Date.now()
): ProviderCooldown | undefined {
  const candidates = [getActiveCooldown(cooldownKey(provider, scope), now)];
  const modelSpecificRateLimitType =
    provider === 'claude' ? getModelSpecificRateLimitType(model) : undefined;
  if (modelSpecificRateLimitType) {
    candidates.push(
      getActiveCooldown(cooldownKey(provider, scope, modelSpecificRateLimitType), now)
    );
  } else if (provider === 'claude') {
    // An unknown model string cannot safely prove that a model-scoped limit
    // does not apply. Only a positively identified different family may pass.
    for (const rateLimitType of CLAUDE_MODEL_RATE_LIMIT_TYPES) {
      candidates.push(getActiveCooldown(cooldownKey(provider, scope, rateLimitType), now));
    }
  }
  const cooldown = candidates
    .filter((candidate): candidate is StoredCooldown => candidate !== undefined)
    .sort((left, right) => right.resetAt - left.resetAt)[0];
  return cooldown ? toPublicCooldown(cooldown) : undefined;
}

/** Return valid provider-native warnings for one provider credential scope. */
export function getProviderUsageWarnings(
  provider: string,
  scope: string,
  now = Date.now()
): ProviderUsageWarning[] {
  discardExpired(now);
  return [...usageWarnings.values()]
    .filter(warning => warning.provider === provider && warning.scope === scope)
    .map(toPublicUsageWarning);
}

/** Return the first valid provider-native warning for compatibility callers. */
export function getProviderUsageWarning(
  provider: string,
  scope: string,
  now = Date.now()
): ProviderUsageWarning | undefined {
  return getProviderUsageWarnings(provider, scope, now)[0];
}

/** User-facing notice for a provider-native cooldown; never implies a fallback. */
export function formatProviderCooldownMessage(
  cooldown: ProviderCooldown,
  messageWasSent: boolean
): string {
  const resetAt = new Date(cooldown.resetAt).toISOString();
  const delivery = messageWasSent
    ? 'The provider reported this during the current attempt; the reply may be incomplete.'
    : 'Archon did not send this message to the provider.';
  const affectedScope =
    cooldown.rateLimitType === 'seven_day_opus'
      ? "Claude's Opus model family"
      : cooldown.rateLimitType === 'seven_day_sonnet'
        ? "Claude's Sonnet model family"
        : 'this provider credential';
  return (
    `Claude reports that ${affectedScope} is rate-limited until ${resetAt}. ` +
    `${delivery} Archon will not automatically replay this message or switch providers mid-turn. ` +
    'A configured task fallback may be selected for a later independent message; otherwise retry after that time or change your provider/model explicitly.'
  );
}
