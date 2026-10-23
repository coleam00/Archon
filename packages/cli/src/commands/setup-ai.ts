/**
 * The AI step of `archon setup`: selecting and installing maintained
 * providers, collecting their auth, and choosing the default assistant, its
 * chat model and its model tiers.
 */
import { confirm, isCancel, log, multiselect, note, select, text } from '@clack/prompts';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getRegisteredProviders, registerProvider, providerRegistry } from '@archon/providers';
import { MAINTAINED_PROVIDER_IDS, isMaintainedProvider } from '@archon/provider-contract';
import { TIER_NAMES, buildAiProfile } from '@archon/workflows/model-validation';
import {
  getArchonHome as pathsGetArchonHome,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  getPluginsPath,
} from '@archon/paths';
import { setInstallDefault } from './ai';
import { DEFAULT_CHAT_MODEL_OPTIONS } from './setup-model-options';
import type { CheckResult } from './doctor-check';
import { checkProviderDiagnostics } from './doctor-providers';
import { providerCommand } from './provider';
import {
  cancelSetup,
  getLog,
  type CodexTokens,
  type SetupConfig,
  type SetupOptions,
} from './setup-shared';
import {
  collectClaudeAuth,
  collectClaudeBinaryPath,
  collectCodexAuth,
  collectPiConfig,
} from './setup-provider-auth';

/** Sentinel select values for the default-chat-model prompt. Prefixed with
 *  `__` so they can never collide with a real model id. */
const KEEP_MODEL = '__keep__';
const CUSTOM_MODEL = '__custom__';

/**
 * Best-effort read of the install-scope default chat model
 * (`assistants.<provider>.model` in ~/.archon/config.yaml) so a setup re-run
 * surfaces the current value (#1999). Hint-only: any read/parse failure
 * returns undefined rather than blocking the wizard — the authoritative parse
 * happens in @archon/core's config loader at runtime.
 */
export function readInstallDefaultModel(
  provider: string,
  configPath: string = join(pathsGetArchonHome(), 'config.yaml')
): string | undefined {
  try {
    if (!existsSync(configPath)) return undefined;
    const parsed: unknown = Bun.YAML.parse(readFileSync(configPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const assistants = (parsed as Record<string, unknown>).assistants;
    if (typeof assistants !== 'object' || assistants === null) return undefined;
    const entry = (assistants as Record<string, unknown>)[provider];
    if (typeof entry !== 'object' || entry === null) return undefined;
    const model = (entry as Record<string, unknown>).model;
    if (typeof model !== 'string') return undefined;
    const trimmed = model.trim();
    // 'inherit' means "no explicit model" in assistant config — treat as unset.
    return trimmed.length > 0 && trimmed !== 'inherit' ? trimmed : undefined;
  } catch {
    // Intentional best-effort fallback: an unreadable/malformed config.yaml
    // must not break setup; the prompt just won't show a current value.
    return undefined;
  }
}

const TIER_DOCS_URL =
  'https://archon.diy/getting-started/ai-assistants/#per-user-credentials-and-ai-settings';

/**
 * Best-effort check for a non-empty `tiers:` block in ~/.archon/config.yaml,
 * mirroring readInstallDefaultModel's read: a setup re-run on an install that
 * already configured tiers must not warn that tiers are missing. Any
 * read/parse failure reports "not configured" — the authoritative parse
 * happens in @archon/core's config loader at runtime.
 */
export function readInstallTiersConfigured(
  configPath: string = join(pathsGetArchonHome(), 'config.yaml')
): boolean {
  try {
    if (!existsSync(configPath)) return false;
    const parsed: unknown = Bun.YAML.parse(readFileSync(configPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return false;
    const tiers = (parsed as Record<string, unknown>).tiers;
    return typeof tiers === 'object' && tiers !== null && Object.keys(tiers).length > 0;
  } catch {
    return false;
  }
}

/**
 * Model-tier step for the chosen default assistant. Built-in tier defaults
 * exist for claude and codex only, and accepting them intentionally writes
 * NOTHING to config.yaml: the built-ins stay implicit so upstream default
 * bumps reach this install on upgrade instead of freezing at setup time.
 * Providers without built-ins get a pointer, not a wizard — `archon ai tier
 * set` and the console AI Settings panel own tier editing.
 */
export async function confirmModelTiers(provider: string): Promise<void> {
  if (readInstallTiersConfigured()) {
    log.info('Model tiers already configured — inspect them with `archon ai tier list`.');
    return;
  }

  let aliases: ReturnType<typeof buildAiProfile>['aliases'] = {};
  try {
    aliases = buildAiProfile(provider).aliases;
  } catch {
    // buildAiProfile is throw-averse; an odd provider lands in the no-defaults branch.
  }
  const rows = TIER_NAMES.flatMap(tier => {
    const preset = aliases[tier];
    return preset ? [`${tier} -> ${preset.provider}/${preset.model}`] : [];
  });

  if (rows.length === TIER_NAMES.length) {
    const useDefaults = await confirm({
      message: `Use the built-in model tiers for ${provider}? (${rows.join(', ')})`,
      initialValue: true,
    });
    if (isCancel(useDefaults)) cancelSetup();
    if (!useDefaults) {
      note(
        'Set your own tiers with `archon ai tier set <tier> <provider> <model>`\n' +
          `or in the console AI Settings -> Model Tiers panel.\nDocs: ${TIER_DOCS_URL}`,
        'Model tiers'
      );
    }
    return;
  }

  log.warning(
    `No built-in model tiers exist for provider '${provider}'. Bundled workflows (and tier-addressed chat) ` +
      'fail until small/medium/large are configured:\n' +
      '  archon ai tier set <tier> <provider> <model>\n' +
      `Docs: ${TIER_DOCS_URL}`
  );
}

/**
 * Build the select options for the default-chat-model step: keep-current/skip
 * first (so plain Enter is the happy path), curated suggestions next, and a
 * free-text escape last.
 */
export function buildDefaultModelChoices(
  provider: string,
  currentModel: string | undefined
): { value: string; label: string; hint?: string }[] {
  const curated = DEFAULT_CHAT_MODEL_OPTIONS[provider] ?? [];
  return [
    {
      value: KEEP_MODEL,
      label: currentModel ? `Keep current (${currentModel})` : 'Keep SDK default',
      ...(currentModel ? {} : { hint: 'set one later with `archon ai default`' }),
    },
    ...curated.map(o => ({ value: o.value, label: o.value, ...(o.hint ? { hint: o.hint } : {}) })),
    { value: CUSTOM_MODEL, label: 'Other…', hint: 'type a model id' },
  ];
}

/**
 * Optional, skippable default-chat-model prompt for the chosen default
 * assistant (#1999). Returns the chosen model string, or undefined when the
 * user keeps the current/SDK default. Free-text escape for anything the
 * curated shortlist misses.
 */
async function collectDefaultChatModel(provider: string): Promise<string | undefined> {
  const currentModel = readInstallDefaultModel(provider);

  const choice = await select({
    message: `Default chat model for ${provider}? (Enter to keep ${currentModel ?? 'the SDK default'})`,
    options: buildDefaultModelChoices(provider, currentModel),
  });

  if (isCancel(choice)) cancelSetup();

  if (choice === KEEP_MODEL) return undefined;

  if (choice === CUSTOM_MODEL) {
    const typed = await text({
      message: `Model id for ${provider}:`,
      placeholder: provider === 'codex' ? 'gpt-5.6-sol' : 'claude-sonnet-4-6',
    });
    if (isCancel(typed)) cancelSetup();
    // clack's text() is typed as string but resolves undefined on an empty
    // submit — guard like the docs-path prompt does. Empty input = same as
    // keeping the default (guide, never gate).
    const trimmed = typeof typed === 'string' ? typed.trim() : '';
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return choice;
}

/**
 * Write the wizard's default assistant (+ optional chat model) to
 * ~/.archon/config.yaml via the SAME install-scope path as
 * `archon ai default <provider> [<model>]` — setInstallDefault writes
 * `defaultAssistant` unconditionally and `assistants.<p>.model` only when a
 * model was chosen, so the pair stays atomic (#1998/#1999). Writing the
 * assistant even when the model is skipped matters: the .env
 * DEFAULT_AI_ASSISTANT is fallback-only (applyEnvOverrides in @archon/core),
 * so a stale config.yaml defaultAssistant from an earlier `archon ai default`
 * would otherwise silently override the wizard's fresh selection.
 *
 * An empty selection preserves the existing config.yaml default. Non-fatal
 * on failure: the env write has already succeeded, so warn and log instead of
 * aborting setup. Returns true when the config was written.
 *
 * The `write` parameter keeps config writes testable without module mocks.
 */
export async function writeInstallDefaults(
  ai: SetupConfig['ai'],
  write: (provider: string, model?: string) => Promise<void> = setInstallDefault
): Promise<boolean> {
  if (!ai.defaultAssistantSelected || ai.defaultAssistant === undefined) return false;
  try {
    await write(ai.defaultAssistant, ai.defaultModel);
    return true;
  } catch (err) {
    // Non-fatal: the user can run `archon ai default <provider> [<model>]`
    // later. Surface, don't swallow.
    const e = err as NodeJS.ErrnoException;
    const code = e.code ? ` (${e.code})` : '';
    log.warning(`Could not write default assistant config: ${e.message}${code}`);
    getLog().warn({ err: e }, 'setup.default_assistant_config_write_failed');
    return false;
  }
}

async function installSetupProviders(ids: readonly string[], repoPath: string): Promise<void> {
  if (!BUNDLED_IS_BINARY) return;
  const pluginsDir = getPluginsPath();
  const result = await providerCommand('add', ids, {
    pluginsDir,
    archonVersion: BUNDLED_VERSION,
    projectDir: repoPath,
  });
  if (result !== 0)
    throw new Error(
      `Provider installation failed. Run: archon provider add <${MAINTAINED_PROVIDER_IDS.join('|')}>`
    );
  const { loadProviderPlugins } = await import('@archon/core/providers/load-provider-plugins');
  for (const registration of await loadProviderPlugins(pluginsDir, { maintained: 'installed' })) {
    if (!providerRegistry.get(registration.id)) registerProvider(registration);
  }
}

export async function selectSetupProviders(
  providers: readonly string[] | undefined,
  install: (ids: readonly string[]) => Promise<void>,
  ask: () => Promise<string[] | symbol> = () =>
    multiselect({
      message: 'Which AI provider(s) should Archon add?',
      options: MAINTAINED_PROVIDER_IDS.map(id => ({
        value: id,
        label: providerRegistry.get(id)?.displayName ?? id,
      })),
      required: false,
    })
): Promise<string[]> {
  const selection = providers ?? (await ask());
  if (isCancel(selection)) cancelSetup();
  if (typeof selection === 'symbol') throw new Error('Invalid provider selection');
  const ids = [...new Set(selection)];
  for (const id of ids) {
    if (!isMaintainedProvider(id)) {
      throw new Error(
        `Unknown maintained provider '${id}'. Choose: ${MAINTAINED_PROVIDER_IDS.join(', ')}`
      );
    }
  }
  if (ids.length === 0) {
    log.warning(
      `No providers selected. Run: archon provider add <${MAINTAINED_PROVIDER_IDS.join('|')}>`
    );
  } else {
    await install(ids);
  }
  return ids;
}

export async function collectAIConfig(
  options: Pick<SetupOptions, 'providers' | 'repoPath'>,
  install: (ids: readonly string[]) => Promise<void> = ids =>
    installSetupProviders(ids, options.repoPath),
  diagnose: (id: string) => Promise<CheckResult[]> = id => checkProviderDiagnostics(id)
): Promise<SetupConfig['ai']> {
  const selectedProviders = await selectSetupProviders(options.providers, install);
  await reportProviderDiagnostics(selectedProviders, diagnose);
  const hasClaude = selectedProviders.includes('claude');
  const hasCodex = selectedProviders.includes('codex');
  const hasPi = selectedProviders.includes('pi');

  let claudeAuthType: 'global' | 'apiKey' | 'oauthToken' | undefined;
  let claudeApiKey: string | undefined;
  let claudeOauthToken: string | undefined;
  let claudeBinaryPath: string | undefined;
  let codexTokens: CodexTokens | undefined;
  let piModel: string | undefined;
  let piApiKey: string | undefined;
  let piApiKeyEnvVar: string | undefined;

  // Collect Claude auth if selected
  if (hasClaude) {
    const claudeAuth = await collectClaudeAuth();
    claudeAuthType = claudeAuth.authType;
    claudeApiKey = claudeAuth.apiKey;
    claudeOauthToken = claudeAuth.oauthToken;
    claudeBinaryPath = await collectClaudeBinaryPath();
  }

  // Collect Codex auth if selected
  if (hasCodex) {
    const tokens = await collectCodexAuth();
    codexTokens = tokens ?? undefined;
  }

  if (hasPi) {
    const piConfig = await collectPiConfig();
    piModel = piConfig.model;
    piApiKey = piConfig.apiKey;
    piApiKeyEnvVar = piConfig.apiKeyEnvVar;
  }

  const defaultAssistant = await selectDefaultAssistant(selectedProviders);

  // Optional, skippable default-chat-model step for the default assistant
  // (#1999). Pi is excluded: its model was already chosen in collectPiConfig
  // and is written by writeHomePiModelConfig.
  let defaultModel: string | undefined;
  if (defaultAssistant !== undefined && defaultAssistant !== 'pi') {
    defaultModel = await collectDefaultChatModel(defaultAssistant);
  }

  return {
    claude: hasClaude,
    claudeAuthType,
    claudeApiKey,
    claudeOauthToken,
    ...(claudeBinaryPath !== undefined ? { claudeBinaryPath } : {}),
    codex: hasCodex,
    codexTokens,
    pi: hasPi,
    piModel,
    piApiKey,
    piApiKeyEnvVar,
    defaultAssistant,
    ...(selectedProviders.length > 0 ? { defaultAssistantSelected: true } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  };
}

async function reportProviderDiagnostics(
  providers: readonly string[],
  diagnose: (id: string) => Promise<CheckResult[]>
): Promise<void> {
  for (const id of providers) {
    for (const check of await diagnose(id)) {
      const message = `${check.label}: ${check.message}`;
      if (check.status === 'fail' || check.status === 'warn') log.warning(message);
      else log.info(message);
    }
  }
}

async function selectDefaultAssistant(
  selectedProviders: readonly string[]
): Promise<string | undefined> {
  let defaultAssistant: string | undefined;

  if (selectedProviders.length > 1) {
    const providerChoices = selectedProviders.map(id => {
      const reg = getRegisteredProviders().find(p => p.id === id);
      const displayName = reg?.displayName ?? id;
      return {
        value: id,
        label: displayName,
      };
    });

    const defaultChoice = await select({
      message: 'Which should be the default AI assistant?',
      options: providerChoices,
    });

    if (isCancel(defaultChoice)) cancelSetup();

    defaultAssistant = defaultChoice;
  } else if (selectedProviders.length === 1) {
    defaultAssistant = selectedProviders[0];
  }

  return defaultAssistant;
}
