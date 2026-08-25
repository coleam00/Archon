import { describe, expect, test } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';

import {
  buildAiProfile,
  createRunModelBindingsMetadata,
  parseRunModelAssignments,
  readRunModelBindingsMetadata,
  resolveRunModelOverrides,
  isEffortValidForProvider,
  isLiteralSpec,
  resolvePresetEffort,
  resolveModelSpec,
  resolveTierWithFallback,
  TIER_NAMES,
  validEffortsForProvider,
  type ModelAliasPreset,
  type ResolvedAiProfile,
} from './model-validation';

// The effort helpers read `effortControl` off the provider registry, so the
// registry has to be populated the way a real entrypoint populates it.
registerBuiltinProviders();
registerCommunityProviders();

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
        '@deep': { provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
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

describe('buildAiProfile — per-user layer (highest precedence)', () => {
  test('user tier overrides repo tier with same key', () => {
    const profile = buildAiProfile('claude', {
      repoTiers: {
        large: { provider: 'claude', model: 'opus' },
      },
      userTiers: {
        large: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
      },
    });
    expect(profile.aliases.large).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    });
  });

  test('user alias overrides repo alias with same name', () => {
    const profile = buildAiProfile('claude', {
      repoAliases: {
        '@cheap': { provider: 'claude', model: 'haiku' },
      },
      userAliases: {
        '@cheap': { provider: 'pi', model: 'openrouter/qwen/qwen3-coder' },
      },
    });
    expect(profile.aliases['@cheap']).toEqual({
      provider: 'pi',
      model: 'openrouter/qwen/qwen3-coder',
    });
  });

  test('repo tier not overridden by user survives alongside user tier', () => {
    const profile = buildAiProfile('claude', {
      repoTiers: {
        small: { provider: 'claude', model: 'haiku' },
      },
      userTiers: {
        large: { provider: 'claude', model: 'opus' },
      },
    });
    expect(profile.aliases.small).toEqual({ provider: 'claude', model: 'haiku' });
    expect(profile.aliases.large).toEqual({ provider: 'claude', model: 'opus' });
  });

  test('per-user default provider rebases tier defaults', () => {
    // The caller passes the user's defaultProvider as the first arg — the
    // built-in tier defaults must follow it, not the install config's provider.
    const profile = buildAiProfile('codex', {});
    expect(profile.defaultProvider).toBe('codex');
    expect(profile.aliases.medium?.provider).toBe('codex');
  });

  test('absent user layer behaves exactly as before', () => {
    const withEmpty = buildAiProfile('claude', {
      repoTiers: { medium: { provider: 'claude', model: 'sonnet' } },
      userTiers: undefined,
      userAliases: undefined,
    });
    const without = buildAiProfile('claude', {
      repoTiers: { medium: { provider: 'claude', model: 'sonnet' } },
    });
    expect(withEmpty).toEqual(without);
  });

  test('user tiers validate tier names like other layers', () => {
    expect(() =>
      buildAiProfile('claude', {
        userTiers: { tiny: { provider: 'claude', model: 'haiku' } } as never,
      })
    ).toThrow(/Tier name 'tiny' is invalid/);
  });

  test('resolveTierWithFallback reports the matched tier (exact match)', () => {
    const profile = buildAiProfile('claude', {});
    const { matchedTier, preset } = resolveTierWithFallback(profile, 'large');
    expect(matchedTier).toBe('large');
    expect(preset.provider).toBe('claude');
  });

  test('resolveTierWithFallback reports the matched tier (fallback)', () => {
    // 'newprovider' has no built-in defaults, so only the configured tier exists.
    const profile = buildAiProfile('newprovider', {
      userTiers: { small: { provider: 'pi', model: 'minimax-m3' } },
    });
    const { matchedTier, preset } = resolveTierWithFallback(profile, 'large');
    expect(matchedTier).toBe('small');
    expect(preset).toEqual({ provider: 'pi', model: 'minimax-m3' });
  });

  test('resolveTierWithFallback throws when no tier preset exists at all', () => {
    const profile = buildAiProfile('newprovider', {});
    expect(() => resolveTierWithFallback(profile, 'large')).toThrow(/no configured preset/);
  });

  test('user aliases validate @ prefix and reserved names', () => {
    expect(() =>
      buildAiProfile('claude', {
        userAliases: { large: { provider: 'claude', model: 'opus' } },
      })
    ).toThrow(/reserved/);
    expect(() =>
      buildAiProfile('claude', {
        userAliases: { fast: { provider: 'claude', model: 'haiku' } },
      })
    ).toThrow(/must start with '@'/);
  });
});

describe('per-run model bindings', () => {
  const base = buildAiProfile('claude', {
    repoAliases: {
      '@planner': { provider: 'claude', model: 'opus', effort: 'high' },
      '@cheap': { provider: 'claude', model: 'haiku' },
    },
  });

  test('parses repeatable tier and alias assignments', () => {
    expect(
      parseRunModelAssignments(['large=openai/gpt-5.6', '@planner=codex/gpt-5.6-sol'])
    ).toEqual({
      tiers: { large: 'openai/gpt-5.6' },
      aliases: { '@planner': 'codex/gpt-5.6-sol' },
    });
  });

  test('rejects bare, malformed, and duplicate assignments', () => {
    expect(() => parseRunModelAssignments(['openai/gpt-5.6'])).toThrow(/Expected/);
    expect(() => parseRunModelAssignments(['large='])).toThrow(/Expected/);
    expect(() => parseRunModelAssignments(['large=   '])).toThrow(/Expected/);
    expect(() => parseRunModelAssignments(['tiny=x'])).toThrow(/must start with '@'/);
    expect(() => parseRunModelAssignments(['large=x', 'large=y'])).toThrow(/Duplicate/);
  });

  test('resolves vendor/model as Pi and changes only the named tier', () => {
    const run = resolveRunModelOverrides(base, { tiers: { large: 'openai/gpt-5.6' } });
    const effective = buildAiProfile('claude', {
      repoAliases: {
        '@planner': { provider: 'claude', model: 'opus', effort: 'high' },
        '@cheap': { provider: 'claude', model: 'haiku' },
      },
      runTiers: run.tiers,
      runAliases: run.aliases,
    });

    expect(effective.aliases.large).toEqual({ provider: 'pi', model: 'openai/gpt-5.6' });
    expect(effective.aliases.small).toEqual(base.aliases.small);
    expect(effective.aliases.medium).toEqual(base.aliases.medium);
    expect(effective.aliases['@planner']).toEqual(base.aliases['@planner']);
    expect(resolveModelSpec(effective, 'medium')).toEqual(base.aliases.medium);
    expect(resolveModelSpec(effective, 'claude-opus-pinned')).toEqual({
      literal: 'claude-opus-pinned',
    });
  });

  test('registered agent refs switch provider and Pi refs validate their nested model', () => {
    expect(
      resolveRunModelOverrides(base, { tiers: { large: 'codex/gpt-5.6-sol' } }).tiers?.large
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });
    expect(
      resolveRunModelOverrides(base, { tiers: { large: 'pi/openrouter/qwen/qwen3' } }).tiers?.large
    ).toEqual({ provider: 'pi', model: 'openrouter/qwen/qwen3' });
    expect(() => resolveRunModelOverrides(base, { tiers: { large: 'pi/not-a-model' } })).toThrow(
      /Expected <vendor>\/<model>/
    );
  });

  test('unqualified literals inherit the target provider and preset refs copy options', () => {
    expect(resolveRunModelOverrides(base, { tiers: { large: 'opus-next' } }).tiers?.large).toEqual({
      provider: 'claude',
      model: 'opus-next',
    });
    expect(
      resolveRunModelOverrides(base, { aliases: { '@cheap': '@planner' } }).aliases?.['@cheap']
    ).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
  });

  test('rejects unknown alias targets and references', () => {
    expect(() => resolveRunModelOverrides(base, { aliases: { '@missing': 'opus' } })).toThrow(
      /unknown alias '@missing'/
    );
    expect(() => resolveRunModelOverrides(base, { tiers: { large: '@missing' } })).toThrow(
      /Unknown alias '@missing'/
    );
  });

  test('metadata round-trips the sparse override and effective snapshot', () => {
    const overrides = resolveRunModelOverrides(base, { tiers: { large: 'openai/gpt-5.6' } });
    const effective = buildAiProfile('claude', {
      repoAliases: {
        '@planner': { provider: 'claude', model: 'opus', effort: 'high' },
        '@cheap': { provider: 'claude', model: 'haiku' },
      },
      runTiers: overrides.tiers,
    });
    const value = createRunModelBindingsMetadata(overrides, effective);

    expect(readRunModelBindingsMetadata({ model_bindings: value })).toEqual(value);
    expect(() => readRunModelBindingsMetadata({ model_bindings: 'bad' })).toThrow(/invalid/);
    expect(() =>
      readRunModelBindingsMetadata({
        model_bindings: { ...value, overrides: { tiers: 1 } },
      })
    ).toThrow(/invalid model_bindings tiers/);
    expect(() =>
      readRunModelBindingsMetadata({
        model_bindings: { ...value, overrides: { aliases: [] } },
      })
    ).toThrow(/invalid model_bindings aliases/);
    expect(() =>
      readRunModelBindingsMetadata({
        model_bindings: {
          ...value,
          overrides: {
            aliases: { planner: { provider: 'claude', model: 'opus' } },
          },
        },
      })
    ).toThrow(/invalid model_bindings aliases/);
    expect(() =>
      readRunModelBindingsMetadata({
        model_bindings: {
          ...value,
          overrides: {
            tiers: {
              large: {
                provider: 'claude',
                model: 'opus',
                thinking: { type: 'enabled', budgetTokens: -1 },
              },
            },
          },
        },
      })
    ).toThrow(/invalid thinking options/);
    expect(() =>
      readRunModelBindingsMetadata({
        model_bindings: {
          ...value,
          effective: {
            ...value.effective,
            aliases: {
              ...value.effective.aliases,
              large: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'warp' },
            },
          },
        },
      })
    ).toThrow(/invalid effort/);
    expect(
      readRunModelBindingsMetadata({
        model_bindings: {
          ...value,
          effective: {
            ...value.effective,
            aliases: {
              ...value.effective.aliases,
              medium: {
                provider: 'opencode',
                model: 'anthropic/claude-sonnet-4-6',
                effort: 'ultra',
              },
            },
          },
        },
      })
    ).toBeDefined();
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

// #2556: one vocabulary, gated by one capability flag. Before this, effort
// "routed" only on Claude and Codex, each with its own enum, so a tier's
// `effort` was silently dropped on Pi and Copilot — which do have the control.
const LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

describe('validEffortsForProvider', () => {
  test('returns the one ladder for every provider with a reasoning control', () => {
    for (const provider of ['claude', 'codex', 'pi', 'copilot']) {
      expect(validEffortsForProvider(provider)).toEqual(LADDER);
    }
  });

  test('returns null for a provider with no reasoning control', () => {
    // OpenCode configures reasoning in opencode.json, not per request.
    expect(validEffortsForProvider('opencode')).toBeNull();
  });

  test('returns null for an unregistered provider rather than throwing', () => {
    // getProviderCapabilities throws on an unknown id; both write paths call
    // this before their own registration check would fire.
    expect(validEffortsForProvider('not-a-provider')).toBeNull();
  });
});

// The one gate the DAG executor and the chat orchestrator share. When they each
// hand-rolled it, "must stay in step" was a comment; here it is a call.
describe('resolvePresetEffort', () => {
  test('accepts a rung on a provider that has the control', () => {
    expect(resolvePresetEffort('codex', 'minimal')).toEqual({ ok: true });
    expect(resolvePresetEffort('pi', 'max')).toEqual({ ok: true });
  });

  test('rejects as unsupported when the provider has no reasoning control', () => {
    expect(resolvePresetEffort('opencode', 'high')).toEqual({
      ok: false,
      reason: 'unsupported',
      valid: null,
    });
  });

  test('rejects as unknown, and reports the vocabulary, for a non-rung', () => {
    const decision = resolvePresetEffort('claude', 'ultra');
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('expected a rejection');
    expect(decision.reason).toBe('unknown');
    expect(decision.valid).toEqual(LADDER);
  });
});

describe('isEffortValidForProvider', () => {
  test('accepts every rung on a provider that has the control', () => {
    for (const rung of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(isEffortValidForProvider('codex', rung)).toBe(true);
      expect(isEffortValidForProvider('claude', rung)).toBe(true);
    }
  });

  test('rejects a value that is not a rung', () => {
    expect(isEffortValidForProvider('claude', 'ultra')).toBe(false);
  });

  test('accepts anything for a provider with no vocabulary to validate against', () => {
    expect(isEffortValidForProvider('opencode', 'ultra')).toBe(true);
  });
});
