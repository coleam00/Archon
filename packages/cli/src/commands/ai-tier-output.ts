import {
  TIER_NAMES,
  type RawAliasEntry,
  type RawTiersConfig,
} from '@archon/workflows/model-validation';

export function buildTierRows(
  configured: RawTiersConfig,
  userTiers: RawTiersConfig,
  defaults: Record<string, RawAliasEntry>
) {
  const toEntry = (
    set: RawAliasEntry | undefined
  ): { provider: string; model: string; effort?: string } | null =>
    set ? { provider: set.provider, model: set.model, effort: set.effort } : null;
  return TIER_NAMES.map(tier => {
    const installEntry = toEntry(configured[tier]);
    const userEntry = toEntry(userTiers[tier]);
    const def = toEntry(defaults[tier]);
    return {
      tier,
      configured: installEntry,
      user: userEntry,
      default: def,
      effective: userEntry ?? installEntry ?? def,
    };
  });
}

export function printTierList(
  defaultAssistant: string | undefined,
  userDefaultAssistant: string | undefined,
  rows: ReturnType<typeof buildTierRows>
): void {
  const assistantSuffix = userDefaultAssistant
    ? `${defaultAssistant}; yours: ${userDefaultAssistant}`
    : defaultAssistant;
  console.log(`Model tiers (default assistant: ${assistantSuffix}):`);
  for (const r of rows) {
    const label = r.tier.padEnd(7);
    if (r.user) {
      const eff = r.user.effort ? ` (effort: ${r.user.effort})` : '';
      console.log(`  ${label} ${r.user.provider}/${r.user.model}${eff} [just you]`);
    } else if (r.configured) {
      const eff = r.configured.effort ? ` (effort: ${r.configured.effort})` : '';
      console.log(`  ${label} ${r.configured.provider}/${r.configured.model}${eff}`);
    } else if (r.default) {
      console.log(`  ${label} (default: ${r.default.provider}/${r.default.model})`);
    } else {
      console.log(`  ${label} (unset)`);
    }
  }
}
