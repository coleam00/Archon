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
import { parsePiModelRef } from '@archon/providers/community/pi';
import tierDefaults from './defaults/tier-defaults.json';
import { EFFORT_LEVELS } from './schemas/dag-node';
import {
  runModelBindingsMetadataSchema,
  TIER_NAMES,
  type ModelAliasPreset,
  type RawAliasEntry,
  type RawAliasesConfig,
  type RawTiersConfig,
  type ResolvedAiProfile,
  type ResolvedRunModelOverrides,
  type RunModelBindingsMetadata,
  type TierName,
} from './schemas/model-binding';

export { TIER_NAMES };
export type {
  ModelAliasPreset,
  RawAliasEntry,
  RawAliasesConfig,
  RawTiersConfig,
  ResolvedAiProfile,
  ResolvedRunModelOverrides,
  RunModelBindingsMetadata,
  TierName,
};

/** Sparse transport shape accepted by one workflow invocation. */
export interface RunModelOverrides {
  tiers?: Partial<Record<TierName, string>>;
  aliases?: Record<string, string>;
}

export const RUN_MODEL_BINDINGS_METADATA_KEY = 'model_bindings';

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

function assertValidPersistedPreset(name: string, entry: ModelAliasPreset): void {
  if (entry.effort !== undefined && !isEffortValidForProvider(entry.provider, entry.effort)) {
    throw new Error(`Model binding '${name}' has an invalid effort.`);
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
  /** One invocation's tier rebindings — highest precedence, sparse by key. */
  runTiers?: RawTiersConfig;
  /** One invocation's alias rebindings — highest precedence, sparse by key. */
  runAliases?: RawAliasesConfig;
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

  for (const layer of [
    options.globalTiers,
    options.repoTiers,
    options.userTiers,
    options.runTiers,
  ]) {
    if (!layer) continue;
    for (const [name, entry] of Object.entries(layer)) {
      assertValidTierName(name);
      assertValidEntry(name, entry);
      aliases[name] = toModelAliasPreset(entry);
    }
  }

  for (const layer of [
    options.globalAliases,
    options.repoAliases,
    options.userAliases,
    options.runAliases,
  ]) {
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

function presetForOverrideTarget(profile: ResolvedAiProfile, name: string): ModelAliasPreset {
  if (isTierName(name)) return resolveTierWithFallback(profile, name).preset;
  assertNotReserved(name);
  assertCustomAliasPrefix(name);
  const preset = profile.aliases[name];
  if (!preset) throw new Error(`Cannot rebind unknown alias '${name}'.`);
  return preset;
}

function resolveRunOverrideSpec(
  profile: ResolvedAiProfile,
  targetName: string,
  rawSpec: string
): RawAliasEntry {
  const spec = rawSpec.trim();
  if (spec.length === 0) throw new Error(`Model override '${targetName}' has an empty spec.`);

  if (isTierName(spec) || spec.startsWith('@')) {
    const resolved = resolveModelSpec(profile, spec);
    if (isLiteralSpec(resolved)) {
      throw new Error(`Model override '${targetName}' could not resolve '${spec}'.`);
    }
    return { ...resolved };
  }

  const slash = spec.indexOf('/');
  if (slash === -1) {
    const target = presetForOverrideTarget(profile, targetName);
    return { provider: target.provider, model: spec };
  }

  const prefix = spec.slice(0, slash);
  const remainder = spec.slice(slash + 1);
  if (isRegisteredProvider(prefix)) {
    if (remainder.length === 0) {
      throw new Error(`Model override '${targetName}' has an empty model id.`);
    }
    if (prefix === 'pi' && !parsePiModelRef(remainder)) {
      throw new Error(
        `Model override '${targetName}' has invalid Pi model '${remainder}'. Expected <vendor>/<model>.`
      );
    }
    return { provider: prefix, model: remainder };
  }

  if (!parsePiModelRef(spec)) {
    throw new Error(
      `Model override '${targetName}' has invalid model '${spec}'. Expected <agent>/<model> or <vendor>/<model>.`
    );
  }
  return { provider: 'pi', model: spec };
}

/**
 * Resolve one invocation's string mappings against the already-layered lower
 * profile. This is the only transport-to-profile boundary used by CLI and HTTP.
 */
export function resolveRunModelOverrides(
  profile: ResolvedAiProfile,
  overrides: RunModelOverrides | undefined
): ResolvedRunModelOverrides {
  if (!overrides) return {};

  const tiers: RawTiersConfig = {};
  for (const [name, spec] of Object.entries(overrides.tiers ?? {})) {
    assertValidTierName(name);
    tiers[name] = resolveRunOverrideSpec(profile, name, spec);
  }

  const aliases: RawAliasesConfig = {};
  for (const [name, spec] of Object.entries(overrides.aliases ?? {})) {
    presetForOverrideTarget(profile, name);
    aliases[name] = resolveRunOverrideSpec(profile, name, spec);
  }

  return {
    ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
  };
}

/** Parse repeated CLI `name=spec` mappings into the shared transport shape. */
export function parseRunModelAssignments(assignments: readonly string[]): RunModelOverrides {
  const tiers: Partial<Record<TierName, string>> = {};
  const aliases: Record<string, string> = {};
  const seen = new Set<string>();

  for (const assignment of assignments) {
    const equals = assignment.indexOf('=');
    if (equals <= 0 || equals === assignment.length - 1) {
      throw new Error(
        `Invalid --model '${assignment}'. Expected <small|medium|large|@alias>=<model>.`
      );
    }
    const name = assignment.slice(0, equals).trim();
    const spec = assignment.slice(equals + 1).trim();
    if (name.length === 0 || spec.length === 0) {
      throw new Error(
        `Invalid --model '${assignment}'. Expected <small|medium|large|@alias>=<model>.`
      );
    }
    if (seen.has(name)) throw new Error(`Duplicate --model binding '${name}'.`);
    seen.add(name);

    if (isTierName(name)) {
      tiers[name] = spec;
    } else {
      assertNotReserved(name);
      assertCustomAliasPrefix(name);
      aliases[name] = spec;
    }
  }

  return {
    ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
  };
}

export function hasRunModelOverrides(overrides: ResolvedRunModelOverrides): boolean {
  return (
    Object.keys(overrides.tiers ?? {}).length > 0 || Object.keys(overrides.aliases ?? {}).length > 0
  );
}

export function runOverrideAppliesToRef(
  overrides: ResolvedRunModelOverrides,
  ref: string | undefined
): boolean {
  if (!ref) return false;
  if (isTierName(ref)) return overrides.tiers?.[ref] !== undefined;
  return ref.startsWith('@') && overrides.aliases?.[ref] !== undefined;
}

export function createRunModelBindingsMetadata(
  overrides: ResolvedRunModelOverrides,
  effective: ResolvedAiProfile
): RunModelBindingsMetadata {
  return {
    overrides: {
      ...(overrides.tiers ? { tiers: { ...overrides.tiers } } : {}),
      ...(overrides.aliases ? { aliases: { ...overrides.aliases } } : {}),
    },
    effective: {
      defaultProvider: effective.defaultProvider,
      aliases: Object.fromEntries(
        Object.entries(effective.aliases).map(([name, preset]) => [name, { ...preset }])
      ),
    },
  };
}

/** Read metadata written by this module; malformed external JSON fails explicitly. */
export function readRunModelBindingsMetadata(
  metadata: Record<string, unknown> | undefined
): RunModelBindingsMetadata | undefined {
  const value = metadata?.[RUN_MODEL_BINDINGS_METADATA_KEY];
  if (value === undefined) return undefined;
  const parsed = runModelBindingsMetadataSchema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    const bindingName = typeof path[2] === 'string' ? path[2] : 'unknown';
    if (path.includes('thinking')) {
      throw new Error(`Model binding '${bindingName}' has invalid thinking options.`);
    }
    if (path.includes('effort')) {
      throw new Error(`Model binding '${bindingName}' has an invalid effort.`);
    }
    if (path[0] === 'overrides' && (path[1] === 'tiers' || path[1] === 'aliases')) {
      throw new Error(`Workflow run has invalid model_bindings ${path[1]} metadata.`);
    }
    if (path[0] === 'effective') {
      throw new Error('Workflow run has invalid effective model bindings.');
    }
    throw new Error('Workflow run has invalid model_bindings metadata.');
  }

  for (const layer of [
    parsed.data.overrides.tiers,
    parsed.data.overrides.aliases,
    parsed.data.effective.aliases,
  ]) {
    for (const [name, preset] of Object.entries(layer ?? {})) {
      assertValidPersistedPreset(name, preset);
    }
  }

  return parsed.data;
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
 * with `effortControl` takes the whole ladder and clamps any rung its SDK lacks
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
