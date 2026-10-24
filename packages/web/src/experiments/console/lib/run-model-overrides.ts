import { TIER_ORDER, type TierName } from './tiers';

export interface RunModelOverrideRow {
  id: number;
  name: string;
  spec: string;
}

export interface CollectedRunModelOverrides {
  tiers?: Partial<Record<TierName, string>>;
  aliases?: Record<string, string>;
}

export function collectRunModelOverrides(
  rows: readonly RunModelOverrideRow[]
): { ok: true; overrides: CollectedRunModelOverrides } | { ok: false; error: string } {
  const tiers: Partial<Record<TierName, string>> = {};
  const aliases: Record<string, string> = {};
  const seen = new Set<string>();

  for (const row of rows) {
    const name = row.name.trim();
    const spec = row.spec.trim();
    if (name === '' && spec === '') continue;
    if (name === '' || spec === '') {
      return { ok: false, error: 'Every model binding needs both a name and a model spec.' };
    }
    if (seen.has(name)) return { ok: false, error: `Model binding '${name}' is duplicated.` };
    seen.add(name);

    const tier = TIER_ORDER.find(t => t === name);
    if (tier !== undefined) {
      tiers[tier] = spec;
    } else if (name.startsWith('@') && name.length > 1) {
      aliases[name] = spec;
    } else {
      return {
        ok: false,
        error: `Model binding '${name}' must be ${TIER_ORDER.join(', ')}, or start with '@'.`,
      };
    }
  }

  return { ok: true, overrides: omitEmptyOverrides(tiers, aliases) };
}

function omitEmptyOverrides(
  tiers: NonNullable<CollectedRunModelOverrides['tiers']>,
  aliases: NonNullable<CollectedRunModelOverrides['aliases']>
): CollectedRunModelOverrides {
  return {
    ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
  };
}
