/**
 * Model alias resolver — pure classification + lookup for workflow `model:` refs.
 *
 * Classifies a model reference string as one of:
 *   - tier keyword (`small` / `medium` / `large`) → looked up in profile with fallback chain
 *   - `@<name>` custom alias → looked up in profile, errors if unknown
 *   - bare literal (anything else) → returned unchanged for SDK pass-through
 *
 * No side effects, no logger, no I/O — apart from the provider registry lookup
 * the effort helpers below need, which is the same static-capability read the
 * loader and DAG executor already do. The `ResolvedAiProfile` is built once by
 * `buildAiProfile()` from layered config (tier defaults → global tiers → repo
 * tiers → global aliases → repo aliases) and then handed to `resolveModelSpec()`
 * per call.
 */

import { getProviderCapabilities, isRegisteredProvider } from '@archon/providers';
import tierDefaults from './defaults/tier-defaults.json';
import { EFFORT_LEVELS, type ThinkingConfig } from './schemas/dag-node';

/** Reserved tier names — cannot be used as custom alias names */
export const TIER_NAMES = ['small', 'medium', 'large'] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** A model preset — provider + model string + optional provider-specific options */
export interface ModelAliasPreset {
  provider: string;
  model: string;
  effort?: string;
  thinking?: ThinkingConfig;
}

/** Alias entry as written in config YAML — user-defined @custom aliases.
 * Structurally identical to ModelAliasPreset; kept separate to distinguish
 * config-layer input from resolved output. */
export interface RawAliasEntry {
  provider: string;
  model: string;
  effort?: string;
  thinking?: ThinkingConfig;
}

/** The aliases map from config YAML — keyed by alias name */
export type RawAliasesConfig = Record<string, RawAliasEntry>;

/** The tiers map from config YAML — keyed by small/medium/large */
export type RawTiersConfig = Partial<Record<TierName, RawAliasEntry>>;

/** The resolved AI profile — used by resolveModelSpec */
export interface ResolvedAiProfile {
  defaultProvider: string;
  /** Fully resolved alias map: includes tier entries (small/medium/large) + @custom entries */
  aliases: Record<string, ModelAliasPreset>;
}

/** What resolveModelSpec returns */
export type ResolvedModelSpec = ModelAliasPreset | { literal: string };

/**
 * Per-tier fallback order. When a workflow asks for `large` but the install
 * has only `small` configured, we walk this chain and pick the first match.
 * Order rationale: prefer a "near miss" in capability over an unrelated tier,
 * but never throw when ANY tier alias exists.
 */
const TIER_FALLBACK: Record<TierName, readonly TierName[]> = {
  large: ['large', 'medium', 'small'],
  medium: ['medium', 'large', 'small'], // prefer over-capable (large) when both sides missing
  small: ['small', 'medium', 'large'],
};

const TIER_DEFAULTS = tierDefaults as Record<
  string,
  Record<TierName, { model: string; effort?: string }>
>;

/** True when `value` is one of the reserved tier keywords (small/medium/large). */
export function isTierName(value: string): value is TierName {
  return (TIER_NAMES as readonly string[]).includes(value);
}

function assertNotReserved(name: string): void {
  if (isTierName(name)) {
    throw new Error(
      `Alias name '${name}' is reserved (small/medium/large are tier keywords). Use a different name.`
    );
  }
}

function assertCustomAliasPrefix(name: string): void {
  if (!name.startsWith('@')) {
    throw new Error(
      `Alias name '${name}' must start with '@' (e.g. '@${name}'). Reserved tier names (small/medium/large) do not need '@'.`
    );
  }
}

function assertValidEntry(name: string, entry: RawAliasEntry): void {
  if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
    throw new Error(`Alias '${name}' has invalid provider — must be a non-empty string.`);
  }
  if (typeof entry.model !== 'string' || entry.model.length === 0) {
    throw new Error(`Alias '${name}' has invalid model — must be a non-empty string.`);
  }
}

function assertValidTierName(name: string): asserts name is TierName {
  if (!isTierName(name)) {
    throw new Error(`Tier name '${name}' is invalid. Supported tiers: ${TIER_NAMES.join(', ')}.`);
  }
}

function toModelAliasPreset(entry: RawAliasEntry): ModelAliasPreset {
  return {
    provider: entry.provider,
    model: entry.model,
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
    ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
  };
}

export interface BuildAiProfileOptions {
  /** Tier overrides from ~/.archon/config.yaml */
  globalTiers?: RawTiersConfig;
  /** Tier overrides from .archon/config.yaml (repo) — override globalTiers on key collision */
  repoTiers?: RawTiersConfig;
  /** Aliases from ~/.archon/config.yaml */
  globalAliases?: RawAliasesConfig;
  /** Aliases from .archon/config.yaml (repo) — override globalAliases on key collision */
  repoAliases?: RawAliasesConfig;
  /** Per-user tier overrides (DB) — highest precedence, override repoTiers on key collision */
  userTiers?: RawTiersConfig;
  /** Per-user aliases (DB) — highest precedence, override repoAliases on key collision */
  userAliases?: RawAliasesConfig;
}

/**
 * Build a ResolvedAiProfile by layering tier defaults → global tiers → repo tiers
 * → per-user tiers → global aliases → repo aliases → per-user aliases.
 * Throws if any alias name collides with a reserved tier name, or if an alias
 * entry has an empty provider or model string, or if an alias key lacks the `@` prefix.
 */
export function buildAiProfile(
  defaultProvider: string,
  options: BuildAiProfileOptions = {}
): ResolvedAiProfile {
  const aliases: Record<string, ModelAliasPreset> = {};

  const tierEntries = TIER_DEFAULTS[defaultProvider];
  if (tierEntries) {
    for (const tier of TIER_NAMES) {
      const entry = tierEntries[tier];
      if (entry) {
        aliases[tier] = {
          provider: defaultProvider,
          model: entry.model,
          ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
        };
      }
    }
  }

  for (const layer of [options.globalTiers, options.repoTiers, options.userTiers]) {
    if (!layer) continue;
    for (const [name, entry] of Object.entries(layer)) {
      assertValidTierName(name);
      assertValidEntry(name, entry);
      aliases[name] = toModelAliasPreset(entry);
    }
  }

  for (const layer of [options.globalAliases, options.repoAliases, options.userAliases]) {
    if (!layer) continue;
    for (const [name, entry] of Object.entries(layer)) {
      assertNotReserved(name);
      assertCustomAliasPrefix(name);
      assertValidEntry(name, entry);
      aliases[name] = toModelAliasPreset(entry);
    }
  }

  return { defaultProvider, aliases };
}

/**
 * Resolve a tier ref against the profile, reporting WHICH tier in the
 * fallback chain actually matched — `matchedTier !== requested` means the
 * requested tier is unset and a sibling preset was used. Callers that want
 * to surface a non-blocking "tier fell back" nudge use this; everything
 * else keeps the simpler {@link resolveModelSpec}.
 */
export function resolveTierWithFallback(
  profile: ResolvedAiProfile,
  tier: TierName
): { preset: ModelAliasPreset; matchedTier: TierName } {
  for (const candidate of TIER_FALLBACK[tier]) {
    const preset = profile.aliases[candidate];
    if (preset) return { preset, matchedTier: candidate };
  }
  throw new Error(
    `Tier '${tier}' has no configured preset and no built-in default for provider '${profile.defaultProvider}'. Configure 'tiers.small/medium/large' in .archon/config.yaml.`
  );
}

/**
 * Classify a `model:` reference and resolve it against the profile.
 *   - tier ('small' | 'medium' | 'large') → preset via fallback chain
 *   - '@<name>' → preset from profile.aliases, or throw if unknown
 *   - anything else → { literal: ref } pass-through
 */
export function resolveModelSpec(profile: ResolvedAiProfile, ref: string): ResolvedModelSpec {
  if (isTierName(ref)) {
    return resolveTierWithFallback(profile, ref).preset;
  }

  if (ref.startsWith('@')) {
    const preset = profile.aliases[ref];
    if (preset) return preset;
    const defined = Object.keys(profile.aliases);
    const list = defined.length > 0 ? defined.join(', ') : '(none)';
    throw new Error(`Unknown alias '${ref}'. Defined aliases: ${list}`);
  }

  return { literal: ref };
}

/** Type guard — narrows ResolvedModelSpec to its `{ literal }` variant. */
export function isLiteralSpec(spec: ResolvedModelSpec): spec is { literal: string } {
  return 'literal' in spec;
}

/**
 * The reasoning-depth vocabulary a provider accepts, or `null` when it has no
 * reasoning control at all (OpenCode configures reasoning in `opencode.json`,
 * not per request).
 *
 * There is one vocabulary now, not one per provider (#2556): every provider
 * with `effortControl` takes the whole ladder and clamps a rung its SDK lacks
 * to the nearest one it has. So this answers "does effort reach this provider",
 * and the ladder answers "is this a rung" — which is what the tier-config write
 * paths (`PATCH /api/config/tiers`, `archon ai tier set --effort`) need to
 * reject `--effort ultra` up front instead of accepting a no-op.
 */
export function validEffortsForProvider(provider: string): readonly string[] | null {
  if (!isRegisteredProvider(provider)) return null;
  return getProviderCapabilities(provider).effortControl ? EFFORT_LEVELS : null;
}

/**
 * True if `effort` is acceptable for `provider`. Providers WITHOUT a reasoning
 * control accept any value (we don't block what we can't validate; it's a no-op
 * for them, not an error).
 */
export function isEffortValidForProvider(provider: string, effort: string): boolean {
  const valid = validEffortsForProvider(provider);
  return valid === null || valid.includes(effort);
}

/** Why a tier/alias preset's `effort` cannot be applied to the resolved provider. */
export type PresetEffortRejection =
  | { ok: false; reason: 'unsupported'; valid: null }
  | { ok: false; reason: 'unknown'; valid: readonly string[] };

/**
 * Decide whether a tier/alias preset's `effort` can be applied to the resolved
 * provider — the one gate the DAG executor and the chat orchestrator must agree
 * on, or the same tier means different reasoning depths in a workflow and in
 * chat.
 *
 * Classifies rather than logs: the two callers keep their own `dag.*` /
 * `orchestrator.*` event namespaces, which is the only thing that differed
 * between them.
 */
export function resolvePresetEffort(
  provider: string,
  effort: string
): { ok: true } | PresetEffortRejection {
  const valid = validEffortsForProvider(provider);
  // The provider has no reasoning control at all (OpenCode configures it in
  // opencode.json, not per request).
  if (valid === null) return { ok: false, reason: 'unsupported', valid: null };
  if (!valid.includes(effort)) return { ok: false, reason: 'unknown', valid };
  return { ok: true };
}
