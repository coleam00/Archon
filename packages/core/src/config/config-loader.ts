/**
 * Configuration loader for Archon YAML config files
 *
 * Loading order (later overrides earlier):
 * 1. Defaults
 * 2. Global config (~/.archon/config.yaml)
 * 3. Repository config (.archon/config.yaml)
 * 4. Environment variables
 *
 * How the layers merge lives in config-merge.ts, and what each block may hold in
 * config-validation.ts.
 */
import { validateWorktreePostCreate } from '@archon/isolation';
import type { OpencodeProviderDefaults } from '@archon/providers/types';
import { readFile as fsReadFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { createLogger, getArchonConfigPath } from '@archon/paths';
import { buildAiProfile, TIER_NAMES } from '@archon/workflows/model-validation';
import type { RawAliasEntry, TierName } from '@archon/workflows/model-validation';
import type {
  GlobalConfig,
  RepoConfig,
  MergedConfig,
  SafeConfig,
  AssistantDefaults,
  ClaudeProviderDefaults,
  CodexProviderDefaults,
  CopilotProviderDefaults,
  PiProviderDefaults,
  RawTiersConfig,
} from './config-types';
import {
  InvalidConfigError,
  isConfigRecord,
  validateAssistantDefaults,
  validateGlobalConfigBlocks,
  validateModelBindingConfig,
  validateWorkflowContinuationConfig,
} from './config-validation';
import {
  applyEnvOverrides,
  getDefaults,
  mergeAssistantDefaults,
  mergeGlobalConfig,
  mergeRepoConfig,
} from './config-merge';

export { InvalidConfigError } from './config-validation';

// Wrapper functions for file I/O - allows mocking without polluting fs/promises globally
export async function readConfigFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf-8');
}

export async function writeConfigFile(
  path: string,
  content: string,
  options?: { flag?: string }
): Promise<void> {
  await writeFile(path, content, { encoding: 'utf-8', ...options });
}

/**
 * A per-key patch for the `tiers:` config. Unlike `RawTiersConfig`, a tier value
 * may be `null` to explicitly UNSET it (RawTiersConfig can't express removal).
 * Consumed by `updateGlobalConfig({ tiers })`.
 */
export type TiersPatch = Partial<Record<TierName, RawAliasEntry | null>>;

/**
 * A per-key patch for the `aliases:` config — `null` explicitly UNSETS an
 * alias. Consumed by `updateGlobalConfig({ aliases })`.
 */
export type AliasesPatch = Record<string, RawAliasEntry | null>;

/**
 * Per-provider allowlist of fields safe to expose to web clients.
 *
 * **Allowlist (not denylist) by design.** Any field not listed here is
 * dropped on its way out. New sensitive fields on a provider default
 * config (binary paths, credentials, absolute filesystem paths, etc.)
 * are hidden by default — you have to opt in to expose them.
 *
 * Unknown provider IDs (community providers not listed below) fall back
 * to the generic empty allowlist: the web UI sees the provider exists,
 * but none of its defaults. Providers whose defaults are safe to surface
 * register their fields here.
 */
const SAFE_ASSISTANT_FIELDS: {
  [P in keyof SafeFieldOwners]: readonly (keyof SafeFieldOwners[P])[];
} = {
  claude: ['model'],
  codex: ['model', 'modelReasoningEffort', 'webSearchMode'],
  // community providers — list each field we're confident is safe to
  // show in the web UI. Unknown providers fall through with no fields.
  opencode: ['model'],
  pi: ['model'],
  copilot: ['model'],
};

/** Each listed field must be a key of its provider's schema-derived defaults. */
interface SafeFieldOwners {
  claude: ClaudeProviderDefaults;
  codex: CodexProviderDefaults;
  opencode: OpencodeProviderDefaults;
  pi: PiProviderDefaults;
  copilot: CopilotProviderDefaults;
}

const safeFieldsByProvider: Partial<Record<string, readonly string[]>> = SAFE_ASSISTANT_FIELDS;

function toSafeAssistantDefaults(assistants: AssistantDefaults): SafeConfig['assistants'] {
  const safeAssistants: SafeConfig['assistants'] = {};

  for (const [providerId, providerDefaults] of Object.entries(assistants)) {
    if (!providerDefaults || typeof providerDefaults !== 'object') continue;

    const allowed = safeFieldsByProvider[providerId] ?? [];
    const safeDefaults: Record<string, unknown> = {};
    for (const field of allowed) {
      const value = (providerDefaults as Record<string, unknown>)[field];
      if (value !== undefined) {
        safeDefaults[field] = value;
      }
    }

    safeAssistants[providerId] = safeDefaults;
  }

  return safeAssistants;
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('config');
  return cachedLog;
}

/**
 * Parse YAML using Bun's native YAML parser
 */
function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
}

/**
 * Parse a config file into its top-level map of settings; an empty file is `{}`.
 * Bun's YAML error names neither the file nor the line, so the message adds the file.
 */
function parseConfigMapping(content: string, configPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`'${configPath}' is not valid YAML (${reason}).`, { cause: error });
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isConfigRecord(parsed)) {
    throw new Error(`'${configPath}' is not a map of settings at its top level.`);
  }
  return parsed;
}

// Cache for loaded configs
let cachedGlobalConfig: GlobalConfig | null = null;

/**
 * Default config file content
 */
const DEFAULT_CONFIG_CONTENT = `# Archon Global Configuration
# See: https://github.com/coleam00/Archon/blob/main/docs/configuration.md

# Bot display name (shown in messages)
# botName: Archon

# Default AI assistant (must match a registered provider, e.g. claude, codex)
# defaultAssistant: claude

# Assistant defaults
# assistants:
#   claude:
#     model: sonnet
#   codex:
#     model: gpt-5.6-sol
#     modelReasoningEffort: medium
#     webSearchMode: disabled
#     additionalDirectories:
#       - /absolute/path/to/other/repo

# Model tier presets (usable as model: small / medium / large)
# tiers:
#   large: { provider: claude, model: opus }
#   medium: { provider: codex, model: gpt-5.6-terra, effort: high }
#   small: { provider: pi, model: minimax-m3 }

# Streaming mode per platform (stream or batch)
# streaming:
#   telegram: stream
#   discord: batch
#   slack: batch

# Concurrency settings
# concurrency:
#   maxConversations: 10
#   providers:        # optional cap on simultaneous attempts per provider; unlisted = unlimited
#     pi: 1
`;

/**
 * Create default config file if it doesn't exist
 */
async function createDefaultConfig(configPath: string): Promise<void> {
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeConfigFile(configPath, DEFAULT_CONFIG_CONTENT, { flag: 'wx' }); // wx = fail if exists
    getLog().info({ configPath }, 'default_config_created');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') {
      // Only log if it's not a "file exists" error
      getLog().warn({ err, configPath }, 'default_config_create_failed');
    }
  }
}

/**
 * Read a config file, or `undefined` when it does not exist.
 *
 * Only a missing file falls back to defaults. An unreadable file fails the load,
 * as do invalid YAML and a block a validator refuses: degrading would silently
 * replace every setting in the file, including models and concurrency.
 */
async function readConfigFileIfPresent(configPath: string): Promise<string | undefined> {
  try {
    return await readConfigFile(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Read ~/.archon/config.yaml. A missing file is created from the documented
 * template and loads as empty. Every other failure throws, naming the file:
 * permissions, YAML syntax, a top level that is not a mapping, or a rejected `tiers`/`aliases`, `streaming`,
 * `attentionNotices`, `concurrency` or `workflows` block.
 */
async function readGlobalConfig(configPath: string): Promise<GlobalConfig> {
  const content = await readConfigFileIfPresent(configPath);
  if (content === undefined) {
    await createDefaultConfig(configPath);
    return {};
  }
  const parsed = parseConfigMapping(content, configPath);
  validateGlobalConfigBlocks(parsed, configPath);
  return parsed as GlobalConfig;
}

/**
 * Load global config from ~/.archon/config.yaml, creating it from the template
 * when missing.
 *
 * Throws when the file cannot be read or parsed, or when any block, including
 * `assistants.*`, names a value Archon cannot honour.
 */
export async function loadGlobalConfig(forceReload = false): Promise<GlobalConfig> {
  if (cachedGlobalConfig && !forceReload) {
    return cachedGlobalConfig;
  }

  const configPath = getArchonConfigPath();
  const parsed = await readGlobalConfig(configPath);
  validateAssistantDefaults(parsed, configPath);
  cachedGlobalConfig = parsed;
  return cachedGlobalConfig;
}

/**
 * Coerce `recommendedWorkflows` to a clean `string[]` of trimmed non-empty
 * entries. Non-array values, non-string entries, and empties are dropped.
 * Advisory data — never throws.
 */
function sanitizeRecommendedWorkflows(raw: unknown, configPath: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    getLog().debug(
      { configPath, rawType: typeof raw },
      'config.recommended_workflows_not_array_ignored'
    );
    return undefined;
  }
  const cleaned: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      cleaned.push(entry.trim());
    } else {
      getLog().debug({ configPath, entry }, 'config.recommended_workflows_entry_ignored');
    }
  }
  return cleaned;
}

async function readRepoConfig(configPath: string): Promise<RepoConfig> {
  const content = await readConfigFileIfPresent(configPath);
  if (content === undefined) return {};
  const raw = parseConfigMapping(content, configPath);
  validateWorkflowContinuationConfig(raw, configPath);
  validateModelBindingConfig(raw, configPath);
  const parsed = raw as RepoConfig;
  const recommendedWorkflows = sanitizeRecommendedWorkflows(
    (parsed as { recommendedWorkflows?: unknown }).recommendedWorkflows,
    configPath
  );
  if (recommendedWorkflows !== undefined) {
    parsed.recommendedWorkflows = recommendedWorkflows;
  } else {
    delete parsed.recommendedWorkflows;
  }
  return parsed;
}

/**
 * Load repository config from .archon/config.yaml. A missing file loads as `{}`.
 *
 * Every other failure throws, naming the file: an unreadable file, invalid
 * YAML, a top level that is not a mapping, or a refused `workflows`, `tiers`,
 * `aliases`, `assistants.*` or `worktree.postCreate` value.
 */
export async function loadRepoConfig(repoPath: string): Promise<RepoConfig> {
  const configPath = join(repoPath, '.archon', 'config.yaml');
  const parsed = await readRepoConfig(configPath);
  validateWorktreePostCreate(parsed.worktree);
  validateAssistantDefaults(parsed, configPath);
  return parsed;
}

/**
 * Load fully merged configuration
 *
 * @param repoPath - Optional repository path for repo-level config
 * @returns Merged configuration with all overrides applied
 */
export async function loadConfig(repoPath?: string): Promise<MergedConfig> {
  // 1. Start with defaults
  let config = getDefaults();

  // 2. Apply global config
  const globalConfig = await loadGlobalConfig();
  config = mergeGlobalConfig(config, globalConfig);

  // 3. Apply repo config if path provided
  let repoConfig: RepoConfig | undefined;
  if (repoPath) {
    repoConfig = await loadRepoConfig(repoPath);
    config = mergeRepoConfig(config, repoConfig);
  }

  // 4. Apply environment overrides — DEFAULT_AI_ASSISTANT is a fallback:
  //    explicit config-file settings take precedence over the env var.
  config = applyEnvOverrides(config, globalConfig, repoConfig);

  return config;
}

/**
 * Clear cached global config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedGlobalConfig = null;
}

/**
 * Log current configuration (for startup)
 */
export function logConfig(config: MergedConfig): void {
  getLog().info(
    {
      assistant: config.assistant,
      streaming: config.streaming,
    },
    'config_loaded'
  );
}

/**
 * Read ~/.archon/config.yaml for a settings write: the file's actual parsed
 * content, unvalidated, so a patch can repair a bad value and every unrelated
 * key survives, where the loaders would refuse the file. Only a missing file
 * starts empty; an unreadable file, invalid YAML or a top level that is not a
 * mapping throws, because merging into `{}` would replace the operator's whole
 * file with just the patch.
 */
async function readGlobalConfigForUpdate(configPath: string): Promise<GlobalConfig> {
  const content = await readConfigFileIfPresent(configPath);
  if (content === undefined) return {};
  return parseConfigMapping(content, configPath) as GlobalConfig;
}

/**
 * Apply a `tiers`/`aliases` patch per key: `null` unsets, a value sets, an
 * absent key keeps the existing entry as-is. Collapses to `undefined` when
 * nothing is left, so no empty block is serialized.
 */
function mergeBindingPatch<T>(
  existing: unknown,
  patch: Record<string, T | null | undefined>
): Record<string, T> | undefined {
  // Existing entries are unvalidated file content (see readGlobalConfigForUpdate);
  // the caller validates the merged result before it is written.
  const kept = isConfigRecord(existing) ? (existing as Record<string, T>) : {};
  const next: Record<string, T> = {};
  for (const [name, entry] of Object.entries(kept)) {
    if (patch[name] === undefined) next[name] = entry;
  }
  for (const [name, entry] of Object.entries(patch)) {
    if (entry !== null && entry !== undefined) next[name] = entry;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

type GlobalConfigUpdates = Partial<Omit<GlobalConfig, 'tiers' | 'aliases'>> & {
  tiers?: TiersPatch;
  aliases?: AliasesPatch;
};

/**
 * Update global config (~/.archon/config.yaml) with partial updates.
 * Reads current config, deep-merges updates, and writes back to YAML.
 * Invalidates the cached config so next loadConfig() picks up changes.
 */
export async function updateGlobalConfig(updates: GlobalConfigUpdates): Promise<void> {
  const configPath = getArchonConfigPath();

  try {
    const current = await readGlobalConfigForUpdate(configPath);
    const merged = applyGlobalConfigUpdates(current, updates);

    // Refuse to persist what the loaders would then refuse to read: a bad value
    // from the settings UI would otherwise brick every later config load, and a
    // bad block already on disk must be repaired, not kept.
    validateGlobalConfigBlocks(merged, configPath);
    validateAssistantDefaults(merged, configPath);

    // Serialize to YAML and write
    const yaml = Bun.YAML.stringify(merged);
    await mkdir(dirname(configPath), { recursive: true });
    await writeConfigFile(configPath, yaml);

    // Invalidate cache so next loadConfig() re-reads
    cachedGlobalConfig = null;

    getLog().info({ configPath }, 'config.update_completed');
  } catch (error) {
    logUpdateFailure(configPath, error);
    throw error;
  }
}

/** Deep-merge: only overwrite defined keys. */
function applyGlobalConfigUpdates(
  current: GlobalConfig,
  updates: GlobalConfigUpdates
): GlobalConfig {
  const merged: GlobalConfig = { ...current };

  if (updates.botName !== undefined) merged.botName = updates.botName;
  if (updates.defaultAssistant !== undefined) merged.defaultAssistant = updates.defaultAssistant;

  if (updates.assistants) merged.assistants = mergeAssistantsUpdate(current, updates.assistants);

  if (updates.streaming) {
    merged.streaming = { ...current.streaming, ...updates.streaming };
  }

  if (updates.concurrency) {
    merged.concurrency = { ...current.concurrency, ...updates.concurrency };
  }

  if (updates.workflows) {
    merged.workflows = {
      ...(isConfigRecord(current.workflows) ? current.workflows : {}),
      ...updates.workflows,
    };
  }

  if (updates.tiers) {
    // Per-key merge: `null` unsets a tier, a value sets it, and an absent key
    // (`undefined`) preserves the existing entry — including one that is not a
    // valid tier, which validation then refuses rather than dropping.
    merged.tiers = mergeBindingPatch(current.tiers, updates.tiers);
  }

  if (updates.aliases) {
    merged.aliases = mergeBindingPatch(current.aliases, updates.aliases);
  }

  return merged;
}

function mergeAssistantsUpdate(
  current: GlobalConfig,
  patch: NonNullable<GlobalConfigUpdates['assistants']>
): AssistantDefaults {
  const assistants = mergeAssistantDefaults(
    mergeAssistantDefaults(getDefaults().assistants, current.assistants),
    patch
  );
  // mergeAssistantDefaults skips a non-object slot, which would let the
  // built-in default silently replace it. Keep what is on disk for every
  // provider the patch does not touch so validation refuses it.
  if (isConfigRecord(current.assistants)) {
    for (const [provider, existing] of Object.entries(current.assistants)) {
      if (existing === null || isConfigRecord(existing)) continue;
      if (patch[provider] === undefined) assistants[provider] = existing;
    }
  }
  return assistants;
}

function logUpdateFailure(configPath: string, error: unknown): void {
  const err = error as { code?: string; message?: string };

  if (error instanceof InvalidConfigError) {
    getLog().warn({ configPath, err: error }, 'config.update_refused');
  } else if (err.code === 'EACCES' || err.code === 'EPERM') {
    getLog().error({ configPath, err: error, code: err.code }, 'config.update_permission_denied');
  } else {
    getLog().error({ configPath, err: error }, 'config.update_failed');
  }
}

/**
 * Built-in tier presets (small/medium/large) for a provider, from
 * tier-defaults.json via buildAiProfile. Lets the settings UI show what an
 * unset tier resolves to. Never throws — an unknown/odd provider (or a throw)
 * yields `undefined` (every consumer uses optional chaining).
 */
function tierDefaultsFor(provider: string | undefined): RawTiersConfig | undefined {
  try {
    const profile = buildAiProfile(provider);
    const out: RawTiersConfig = {};
    for (const tier of TIER_NAMES) {
      const preset = profile.aliases[tier];
      if (preset) {
        out[tier] = {
          provider: preset.provider,
          model: preset.model,
          ...(preset.effort !== undefined ? { effort: preset.effort } : {}),
        };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch (error) {
    getLog().warn({ provider, err: error }, 'config.tier_defaults_failed');
    return undefined;
  }
}

/**
 * Project a MergedConfig to a SafeConfig suitable for sending to web clients.
 * Strips filesystem paths and any other server-internal fields.
 */
export function toSafeConfig(config: MergedConfig): SafeConfig {
  return {
    botName: config.botName,
    assistant: config.assistant,
    assistants: toSafeAssistantDefaults(config.assistants),
    streaming: { ...config.streaming },
    concurrency: { maxConversations: config.concurrency.maxConversations },
    defaults: {
      loadDefaultCommands: config.defaults.loadDefaultCommands,
      loadDefaultWorkflows: config.defaults.loadDefaultWorkflows,
    },
    tiers: config.tiers,
    tierDefaults: tierDefaultsFor(config.assistant),
    aliases: config.aliases,
  };
}
