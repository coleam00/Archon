import { describe, expect, test } from 'bun:test';

import {
  buildAiProfile,
  isLiteralSpec,
  resolveModelSpec,
  TIER_NAMES,
  type ModelAliasPreset,
  type ResolvedAiProfile,
} from './model-validation';

describe('TIER_NAMES constant', () => {
  test('contains exactly small, medium, large', () => {
    expect([...TIER_NAMES]).toEqual(['small', 'medium', 'large']);
  });
});

describe('buildAiProfile — tier defaults', () => {
  test('builds tier aliases for claude default provider', () => {
    const profile = buildAiProfile('claude');
    expect(profile.aliases.small).toBeDefined();
    expect(profile.aliases.medium).toBeDefined();
    expect(profile.aliases.large).toBeDefined();
  });

  test('injects provider into each tier entry', () => {
    const profile = buildAiProfile('claude');
    expect(profile.aliases.small?.provider).toBe('claude');
    expect(profile.aliases.medium?.provider).toBe('claude');
    expect(profile.aliases.large?.provider).toBe('claude');
  });

  test('preserves effort from tier defaults (codex)', () => {
    const profile = buildAiProfile('codex');
    expect(profile.aliases.small?.effort).toBe('minimal');
    expect(profile.aliases.medium?.effort).toBe('medium');
    expect(profile.aliases.large?.effort).toBe('high');
  });

  test('unknown provider yields empty alias map (no tier defaults)', () => {
    const profile = buildAiProfile('newprovider');
    expect(profile.defaultProvider).toBe('newprovider');
    expect(Object.keys(profile.aliases)).toEqual([]);
  });
});

describe('buildAiProfile — alias layering', () => {
  test('global tier override can point large to another provider', () => {
    const profile = buildAiProfile('codex', {
      globalTiers: {
        large: { provider: 'claude', model: 'opus' },
      },
    });
    expect(profile.aliases.large).toEqual({ provider: 'claude', model: 'opus' });
    expect(profile.aliases.medium?.provider).toBe('codex');
  });

  test('repo tier overrides global tier with same key', () => {
    const profile = buildAiProfile('claude', {
      globalTiers: {
        medium: { provider: 'claude', model: 'sonnet' },
        small: { provider: 'claude', model: 'haiku' },
      },
      repoTiers: {
        medium: { provider: 'codex', model: 'gpt-5.5', effort: 'medium' },
      },
    });
    expect(profile.aliases.medium).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
    });
    expect(profile.aliases.small).toEqual({ provider: 'claude', model: 'haiku' });
  });

  test('partial tier configs still use fallback order', () => {
    const profile = buildAiProfile('newprovider', {
      repoTiers: {
        small: { provider: 'pi', model: 'minimax-m3' },
      },
    });
    expect(resolveModelSpec(profile, 'large')).toEqual({
      provider: 'pi',
      model: 'minimax-m3',
    });
  });

  test('tier entry effort and thinking are preserved', () => {
    const profile = buildAiProfile('claude', {
      repoTiers: {
        large: {
          provider: 'claude',
          model: 'opus',
          effort: 'max',
          thinking: { type: 'enabled', budgetTokens: 10000 },
        },
      },
    });
    expect(profile.aliases.large).toEqual({
      provider: 'claude',
      model: 'opus',
      effort: 'max',
      thinking: { type: 'enabled', budgetTokens: 10000 },
    });
  });

  test('rejects unknown tier override key', () => {
    expect(() =>
      buildAiProfile('claude', {
        repoTiers: {
          // Intentional invalid config shape to exercise runtime validation.
          tiny: { provider: 'claude', model: 'haiku' },
        } as never,
      })
    ).toThrow(/Tier name 'tiny' is invalid/);
  });

  test('repo alias overrides global alias with same name', () => {
    const profile = buildAiProfile('claude', {
      globalAliases: {
        '@cheap': { provider: 'claude', model: 'haiku' },
      },
      repoAliases: {
        '@cheap': { provider: 'codex', model: 'gpt-5-mini' },
      },
    });
    expect(profile.aliases['@cheap']).toEqual({
      provider: 'codex',
      model: 'gpt-5-mini',
    });
  });

  test('global alias not overridden by repo survives', () => {
    const profile = buildAiProfile('claude', {
      globalAliases: {
        '@reasoning': { provider: 'claude', model: 'opus' },
      },
      repoAliases: {
        '@cheap': { provider: 'claude', model: 'haiku' },
      },
    });
    expect(profile.aliases['@reasoning']).toEqual({
      provider: 'claude',
      model: 'opus',
    });
    expect(profile.aliases['@cheap']).toEqual({
      provider: 'claude',
      model: 'haiku',
    });
  });

  test('custom @ prefix aliases are included in the map', () => {
    const profile = buildAiProfile('claude', {
      globalAliases: {
        '@fast': { provider: 'claude', model: 'haiku' },
      },
    });
    expect(profile.aliases['@fast']).toBeDefined();
  });

  test('alias entry effort is preserved', () => {
    const profile = buildAiProfile('codex', {
      repoAliases: {
        '@deep': { provider: 'codex', model: 'gpt-5.3-codex', effort: 'xhigh' },
      },
    });
    expect(profile.aliases['@deep']?.effort).toBe('xhigh');
  });

  test('alias entry thinking is preserved', () => {
    const profile = buildAiProfile('claude', {
      repoAliases: {
        '@think': {
          provider: 'claude',
          model: 'opus',
          thinking: { type: 'enabled', budgetTokens: 10000 },
        },
      },
    });
    expect(profile.aliases['@think']?.thinking).toEqual({
      type: 'enabled',
      budgetTokens: 10000,
    });
  });
});

describe('buildAiProfile — reserved name validation', () => {
  test('rejects reserved "small" in globalAliases', () => {
    expect(() =>
      buildAiProfile('claude', {
        globalAliases: { small: { provider: 'claude', model: 'opus' } },
      })
    ).toThrow(/reserved/);
  });

  test('rejects reserved "medium" in repoAliases', () => {
    expect(() =>
      buildAiProfile('claude', {
        repoAliases: { medium: { provider: 'claude', model: 'opus' } },
      })
    ).toThrow(/reserved/);
  });

  test('rejects reserved "large" in repoAliases', () => {
    expect(() =>
      buildAiProfile('claude', {
        repoAliases: { large: { provider: 'claude', model: 'opus' } },
      })
    ).toThrow(/reserved/);
  });

  test('error message names the offending tier keyword', () => {
    expect(() =>
      buildAiProfile('claude', {
        globalAliases: { small: { provider: 'claude', model: 'opus' } },
      })
    ).toThrow(/'small'/);
  });

  test('rejects alias entry with empty provider', () => {
    expect(() =>
      buildAiProfile('claude', {
        repoAliases: { '@bad': { provider: '', model: 'opus' } },
      })
    ).toThrow(/provider/);
  });

  test('rejects alias entry with empty model', () => {
    expect(() =>
      buildAiProfile('claude', {
        repoAliases: { '@bad': { provider: 'claude', model: '' } },
      })
    ).toThrow(/model/);
  });

  test('rejects alias key without @ prefix', () => {
    expect(() =>
      buildAiProfile('claude', {
        repoAliases: { cheap: { provider: 'claude', model: 'haiku' } },
      })
    ).toThrow(/'@cheap'/);
  });
});

describe('resolveModelSpec — tier classification', () => {
  test("'large' returns preset for large tier", () => {
    const profile = buildAiProfile('claude');
    const spec = resolveModelSpec(profile, 'large');
    expect(spec).toEqual({ provider: 'claude', model: 'opus' });
  });

  test("'medium' returns preset for medium tier", () => {
    const profile = buildAiProfile('claude');
    const spec = resolveModelSpec(profile, 'medium');
    expect(spec).toEqual({ provider: 'claude', model: 'sonnet' });
  });

  test("'small' returns preset for small tier", () => {
    const profile = buildAiProfile('claude');
    const spec = resolveModelSpec(profile, 'small');
    expect(spec).toEqual({ provider: 'claude', model: 'haiku' });
  });

  test('returned preset has provider and model fields', () => {
    const profile = buildAiProfile('claude');
    const spec = resolveModelSpec(profile, 'large') as ModelAliasPreset;
    expect(typeof spec.provider).toBe('string');
    expect(typeof spec.model).toBe('string');
  });
});

describe('resolveModelSpec — tier fallback chains', () => {
  function profileWithTiers(
    tiers: Partial<Record<'small' | 'medium' | 'large', string>>
  ): ResolvedAiProfile {
    const aliases: Record<string, ModelAliasPreset> = {};
    for (const [tier, model] of Object.entries(tiers)) {
      if (model) aliases[tier] = { provider: 'claude', model };
    }
    return { defaultProvider: 'claude', aliases };
  }

  test('only small configured → large falls back to small', () => {
    const profile = profileWithTiers({ small: 'haiku' });
    expect(resolveModelSpec(profile, 'large')).toEqual({
      provider: 'claude',
      model: 'haiku',
    });
  });

  test('only small configured → medium falls back to small', () => {
    const profile = profileWithTiers({ small: 'haiku' });
    expect(resolveModelSpec(profile, 'medium')).toEqual({
      provider: 'claude',
      model: 'haiku',
    });
  });

  test('small and medium configured → large falls back to medium', () => {
    const profile = profileWithTiers({ small: 'haiku', medium: 'sonnet' });
    expect(resolveModelSpec(profile, 'large')).toEqual({
      provider: 'claude',
      model: 'sonnet',
    });
  });

  test('only large configured → small falls back to large', () => {
    const profile = profileWithTiers({ large: 'opus' });
    expect(resolveModelSpec(profile, 'small')).toEqual({
      provider: 'claude',
      model: 'opus',
    });
  });

  test('only large configured → medium falls back to large', () => {
    const profile = profileWithTiers({ large: 'opus' });
    expect(resolveModelSpec(profile, 'medium')).toEqual({
      provider: 'claude',
      model: 'opus',
    });
  });

  test('large and small configured (no medium) → medium prefers large', () => {
    const profile = profileWithTiers({ small: 'haiku', large: 'opus' });
    expect(resolveModelSpec(profile, 'medium')).toEqual({
      provider: 'claude',
      model: 'opus',
    });
  });

  test('no tier aliases in profile → throws with actionable message', () => {
    const profile: ResolvedAiProfile = {
      defaultProvider: 'newprovider',
      aliases: {},
    };
    expect(() => resolveModelSpec(profile, 'large')).toThrow(
      /Tier 'large'.*newprovider.*tiers\.small\/medium\/large/
    );
  });
});

describe('resolveModelSpec — @custom alias', () => {
  test('known @alias returns preset from profile', () => {
    const profile = buildAiProfile('claude', {
      repoAliases: {
        '@cheap': { provider: 'claude', model: 'haiku' },
      },
    });
    expect(resolveModelSpec(profile, '@cheap')).toEqual({
      provider: 'claude',
      model: 'haiku',
    });
  });

  test('unknown @alias throws listing defined aliases', () => {
    const profile = buildAiProfile('claude', {
      repoAliases: {
        '@cheap': { provider: 'claude', model: 'haiku' },
      },
    });
    expect(() => resolveModelSpec(profile, '@unknown')).toThrow(/Unknown alias '@unknown'/);
    expect(() => resolveModelSpec(profile, '@unknown')).toThrow(/@cheap/);
  });

  test('unknown @alias with empty alias map throws listing "(none)"', () => {
    const profile: ResolvedAiProfile = {
      defaultProvider: 'newprovider',
      aliases: {},
    };
    expect(() => resolveModelSpec(profile, '@unknown')).toThrow(/\(none\)/);
  });
});

describe('resolveModelSpec — literal pass-through', () => {
  const emptyProfile: ResolvedAiProfile = {
    defaultProvider: 'claude',
    aliases: {},
  };

  test("'opus' returns { literal: 'opus' }", () => {
    expect(resolveModelSpec(emptyProfile, 'opus')).toEqual({ literal: 'opus' });
  });

  test("'claude-opus-4-7' returns { literal: 'claude-opus-4-7' }", () => {
    expect(resolveModelSpec(emptyProfile, 'claude-opus-4-7')).toEqual({
      literal: 'claude-opus-4-7',
    });
  });

  test("'gpt-5' returns { literal: 'gpt-5' }", () => {
    expect(resolveModelSpec(emptyProfile, 'gpt-5')).toEqual({ literal: 'gpt-5' });
  });

  test('literal return does NOT have provider or model fields', () => {
    const spec = resolveModelSpec(emptyProfile, 'sonnet');
    expect(spec).not.toHaveProperty('provider');
    expect(spec).not.toHaveProperty('model');
  });

  test('literal pass-through ignores configured tier defaults', () => {
    const profile = buildAiProfile('claude');
    // bare literal — not a tier keyword, no @ prefix → pass-through verbatim
    expect(resolveModelSpec(profile, 'sonnet-3.5')).toEqual({ literal: 'sonnet-3.5' });
  });
});

describe('isLiteralSpec type guard', () => {
  test('returns true for { literal: ... }', () => {
    expect(isLiteralSpec({ literal: 'foo' })).toBe(true);
  });

  test('returns false for a ModelAliasPreset', () => {
    expect(isLiteralSpec({ provider: 'claude', model: 'opus' })).toBe(false);
  });
});
