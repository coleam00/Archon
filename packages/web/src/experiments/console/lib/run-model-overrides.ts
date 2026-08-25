export const RUN_MODEL_TIERS = ['small', 'medium', 'large'] as const;
export type RunModelTier = (typeof RUN_MODEL_TIERS)[number];

export interface RunModelOverrideRow {
  id: number;
  name: string;
  spec: string;
}

export interface CollectedRunModelOverrides {
  tiers?: Partial<Record<RunModelTier, string>>;
  aliases?: Record<string, string>;
}

export function collectRunModelOverrides(
  rows: readonly RunModelOverrideRow[]
): { ok: true; overrides: CollectedRunModelOverrides } | { ok: false; error: string } {
  const tiers: Partial<Record<RunModelTier, string>> = {};
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

    if ((RUN_MODEL_TIERS as readonly string[]).includes(name)) {
      tiers[name as RunModelTier] = spec;
    } else if (name.startsWith('@') && name.length > 1) {
      aliases[name] = spec;
    } else {
      return {
        ok: false,
        error: `Model binding '${name}' must be small, medium, large, or start with '@'.`,
      };
    }
  }

  return {
    ok: true,
    overrides: {
      ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
      ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    },
  };
}
