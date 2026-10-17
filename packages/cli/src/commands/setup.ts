/**
 * Setup command - Interactive CLI wizard for Archon credential configuration
 *
 * Guides users through configuring:
 * - Selected maintained AI providers and their native authentication
 * - Platform connections (GitHub, Telegram, Slack — all skippable)
 *
 * SQLite is the implicit default; no database prompt. PostgreSQL users set
 * DATABASE_URL by hand (documented separately).
 *
 * Writes configuration to one archon-owned env file, chosen by --scope:
 *   - 'home'    (default)  → ~/.archon/.env
 *   - 'project'            → <repo>/.archon/.env
 *
 * Never writes to <repo>/.env — that file is stripped at boot by stripCwdEnv()
 * (see #1302 / #1303 three-path model). Writing there would be incoherent
 * (values would be silently deleted on the next run).
 *
 * Writes are merge-only by default: existing non-empty values are preserved,
 * user-added custom keys survive, and a timestamped backup is written before
 * every rewrite. A confirmed GitHub authentication replacement affects only its auth keys.
 * `--force` skips the merge (proposed wins) but still backs up.
 */
import {
  intro,
  outro,
  text,
  password,
  select,
  multiselect,
  confirm,
  note,
  spinner,
  isCancel,
  cancel,
  log,
} from '@clack/prompts';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';
import { join, resolve } from 'path';
import { loadGitHubAppConfig } from '@archon/core/github-auth/config';
import { copyArchonSkill } from './skill';
import { setInstallDefault } from './ai';
import { randomBytes, createPrivateKey } from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { execFileAsync } from '@archon/git';
import {
  GITHUB_APP_CREDENTIAL_KEYS,
  GITHUB_PAT_KEYS,
  selectGitHubAuthMode,
} from '@archon/core/utils/github-auth-mode';
import { getRegisteredProviders, registerProvider, providerRegistry } from '@archon/providers';
import { MAINTAINED_PROVIDER_IDS, isMaintainedProvider } from '@archon/provider-contract';
import { providerCommand } from './provider';
import { checkProviderDiagnostics, type CheckResult } from './doctor';
import { TIER_NAMES, buildAiProfile } from '@archon/workflows/model-validation';
import {
  getArchonHome as pathsGetArchonHome,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  getPluginsPath,
  expandTilde,
} from '@archon/paths';
import {
  SetupExit,
  cancelSetup,
  exitSetup,
  getLog,
  type CodexTokens,
  type GitHubConfig,
  type SetupConfig,
  type SetupOptions,
  type SlackConfig,
  type TelegramConfig,
} from './setup-shared';
import {
  collectClaudeAuth,
  collectClaudeBinaryPath,
  collectCodexAuth,
  collectPiConfig,
  writeHomePiModelConfig,
} from './setup-provider-auth';
import {
  checkExistingConfig,
  generateEnvContent,
  hasCompleteAppCredential,
  mergeScopedEnv,
  resolveScopedEnvPath,
  writeScopedEnv,
} from './setup-env';

// =============================================================================
// Types
// =============================================================================

/**
 * Curated default-chat-model suggestions for the built-in SDK providers
 * (#1999). CONVENIENCE only, not authority — mirrors CLAUDE_MODEL_OPTIONS /
 * CODEX_MODEL_OPTIONS in packages/web/src/experiments/console/lib/
 * model-options.ts (the web package can't be imported from the CLI, same
 * mirroring convention as that file's effort vocabularies). The prompt always
 * keeps a free-text escape; nothing blocks an unlisted model string.
 */
const DEFAULT_CHAT_MODEL_OPTIONS: Record<string, { value: string; hint?: string }[]> = {
  claude: [
    { value: 'sonnet', hint: 'balanced (SDK default)' },
    { value: 'opus', hint: 'most capable' },
    { value: 'haiku', hint: 'fastest' },
  ],
  codex: [{ value: 'gpt-5.6-sol' }, { value: 'gpt-5.6-terra' }, { value: 'gpt-5.6-luna' }],
};

/** Sentinel select values for the default-chat-model prompt. Prefixed with
 *  `__` so they can never collide with a real model id. */
const KEEP_MODEL = '__keep__';
const CUSTOM_MODEL = '__custom__';

interface SpawnResult {
  success: boolean;
  error?: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate a cryptographically secure webhook secret
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

// =============================================================================
// Data Collection Functions
// =============================================================================

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
async function confirmModelTiers(provider: string): Promise<void> {
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
  for (const id of selectedProviders) {
    for (const check of await diagnose(id)) {
      const message = `${check.label}: ${check.message}`;
      if (check.status === 'fail' || check.status === 'warn') log.warning(message);
      else log.info(message);
    }
  }
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

/**
 * Collect platform selection
 */
async function collectPlatforms(): Promise<SetupConfig['platforms']> {
  const platforms = await multiselect({
    message:
      'Which chat adapters do you want to connect? (all optional — Archon works as CLI + skill without any)\n(↑↓ navigate, space select, enter confirm)',
    options: [
      { value: 'github', label: 'GitHub', hint: 'Respond to issues/PRs via webhooks' },
      { value: 'telegram', label: 'Telegram', hint: 'Chat bot via BotFather' },
      { value: 'slack', label: 'Slack', hint: 'Workspace app with Socket Mode' },
    ],
    required: false,
  });

  if (isCancel(platforms)) cancelSetup();

  return {
    github: platforms.includes('github'),
    telegram: platforms.includes('telegram'),
    slack: platforms.includes('slack'),
  };
}

/**
 * Collect GitHub credentials
 */
async function collectGitHubConfig(): Promise<GitHubConfig> {
  const mode = await select({
    message: 'GitHub authentication mode?',
    initialValue: 'pat',
    options: [
      { value: 'pat', label: 'Personal access token', hint: 'Default for solo use' },
      { value: 'app', label: 'GitHub App', hint: 'Recommended for teams' },
    ],
  });
  if (isCancel(mode)) cancelSetup();
  return mode === 'app' ? collectGitHubAppConfig() : collectGitHubPatConfig();
}

async function collectGitHubAppConfig(): Promise<GitHubConfig> {
  note(
    'Follow the GitHub App guide for registration, permissions, webhook events, and installation:\n' +
      'https://archon.diy/adapters/github-app-setup/',
    'GitHub App Setup'
  );
  const appId = await text({
    message: 'GitHub App ID:',
    validate: value =>
      value && /^[0-9]+$/.test(value.trim()) && /[1-9]/.test(value)
        ? undefined
        : 'Enter a positive decimal App ID',
  });
  if (isCancel(appId)) cancelSetup();
  const source = await select({
    message: 'GitHub App private key source?',
    options: [
      { value: 'path', label: 'Path to a PEM file' },
      { value: 'inline', label: 'Inline PEM', hint: 'Use literal \\n for line breaks' },
    ],
  });
  if (isCancel(source)) cancelSetup();
  const resolveKeyPath = (value: string): string => resolve(expandTilde(value.trim()));
  const validateKey = (value: string | undefined): string | undefined => {
    if (!value?.trim()) return 'A private key is required';
    try {
      const pem =
        source === 'path'
          ? readFileSync(resolveKeyPath(value), 'utf8')
          : value.replace(/\\r\\n|\\n/g, '\n');
      if (createPrivateKey(pem).asymmetricKeyType !== 'rsa') return 'Use an RSA PEM private key';
    } catch {
      return 'Enter a readable RSA PEM private key';
    }
    return undefined;
  };
  const key =
    source === 'path'
      ? await text({ message: 'GitHub App private key path:', validate: validateKey })
      : await password({ message: 'GitHub App private key (PEM):', validate: validateKey });
  if (isCancel(key)) cancelSetup();
  const webhookSecret = await password({
    message: 'GitHub webhook secret:',
    validate: value =>
      value?.trim() ? undefined : 'Enter the secret configured on your GitHub App',
  });
  if (isCancel(webhookSecret)) cancelSetup();
  const slug = await text({ message: 'GitHub App slug (optional):' });
  if (isCancel(slug)) cancelSetup();
  return {
    mode: 'app',
    appId: appId.trim(),
    privateKey:
      source === 'path'
        ? { source: 'path', value: resolveKeyPath(key) }
        : { source: 'inline', value: key.replace(/\\r\\n|\\n/g, '\n') },
    webhookSecret,
    slug: slug.trim() || undefined,
    allowedUsers: await collectGitHubAllowedUsers(),
  };
}

async function collectGitHubAllowedUsers(): Promise<string> {
  const allowedUsers = await text({
    message: 'Enter allowed GitHub usernames (comma-separated, or leave empty for all):',
    placeholder: 'username1,username2',
  });

  if (isCancel(allowedUsers)) cancelSetup();
  return allowedUsers;
}

async function collectGitHubPatConfig(): Promise<GitHubConfig> {
  note(
    'GitHub Personal Access Token Setup\n\n' +
      '1. Go to github.com/settings/tokens\n' +
      '2. Click "Generate new token" -> "Generate new token (classic)"\n' +
      '3. Set an expiration and select these scopes:\n' +
      '   - repo (clone and push, issues, pull requests, and reading CI check\n' +
      '     state, which gh queries through GraphQL statusCheckRollup)\n' +
      '   - workflow (only if runs may change .github/workflows/ files)\n' +
      '4. Generate and copy the token\n\n' +
      'A fine-grained token cannot read GitHub Actions check runs: GitHub exposes\n' +
      'no Checks permission to them, so a workflow that waits on CI stops there.\n' +
      'The repo scope is broad, so prefer GitHub App mode when you want access\n' +
      'granted per repository (docs: adapters/github-app-setup).',
    'GitHub Setup'
  );

  const token = await password({
    message: 'Enter your GitHub Personal Access Token:',
    validate: value => {
      if (!value || value.length < 10) {
        return 'Please enter a valid token';
      }
      return undefined;
    },
  });

  if (isCancel(token)) cancelSetup();

  // Probe `gh` CLI auth — workflows that shell out to `gh` (e.g. `gh issue
  // create`, `gh pr edit`) need this even if the PAT is set, because they call
  // the local `gh` binary, not the API directly.
  const ghSpin = spinner();
  ghSpin.start('Checking gh CLI authentication...');
  let ghAuthOk = false;
  let ghAuthError: string | undefined;
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    ghAuthOk = true;
    ghSpin.stop('gh CLI is authenticated');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    ghAuthError =
      e.code === 'ENOENT'
        ? 'gh not found in PATH — install it first (https://cli.github.com)'
        : (e.message ?? 'unknown error');
    ghSpin.stop('gh CLI check failed');
  }

  if (!ghAuthOk) {
    log.warning(
      `gh auth check failed: ${ghAuthError}\n` +
        (ghAuthError?.includes('not found') ? '' : 'Run: gh auth login')
    );
    // gh auth login is an interactive OAuth flow — only offer it from a TTY.
    if (process.stdout.isTTY) {
      const runGhLogin = await confirm({
        message: 'Run `gh auth login` now?',
        initialValue: true,
      });
      if (!isCancel(runGhLogin) && runGhLogin) {
        // spawnSync with inherited stdio so the OAuth prompt reaches the terminal.
        const ghLoginResult = spawnSync('gh', ['auth', 'login'], { stdio: 'inherit' });
        if (ghLoginResult.error) {
          log.warning(
            `Could not run gh auth login: ${ghLoginResult.error.message}. ` +
              'Install the gh CLI from https://cli.github.com/ and run it manually.'
          );
        } else if (ghLoginResult.status !== 0) {
          // gh exited non-zero (user cancelled, OAuth callback failed, etc.).
          // .error is only set on spawn failure, so without this the wizard
          // would proceed as if auth succeeded.
          log.warning(
            `gh auth login exited with code ${ghLoginResult.status ?? 'null'}. ` +
              'Authentication may not have completed — re-run `gh auth login` manually if needed.'
          );
        }
      }
    }
  }

  const allowedUsers = await collectGitHubAllowedUsers();

  const customMention = await confirm({
    message: 'Do you want to set a custom @mention name? (Default: archon)',
  });

  if (isCancel(customMention)) cancelSetup();

  let botMention: string | undefined;
  if (customMention) {
    const mention = await text({
      message: 'Enter the @mention name (without @):',
      placeholder: 'archon',
      validate: value => {
        if (!value) return 'Mention name is required';
        if (value.includes('@')) return 'Do not include @ symbol';
        return undefined;
      },
    });

    if (isCancel(mention)) cancelSetup();

    botMention = mention;
  }

  // Auto-generate webhook secret
  const webhookSecret = generateWebhookSecret();
  log.success('Generated webhook secret (will be saved as WEBHOOK_SECRET in the env file)');

  return {
    mode: 'pat',
    token,
    webhookSecret,
    allowedUsers: allowedUsers || '',
    botMention,
  };
}

/**
 * Collect Telegram credentials
 */
async function collectTelegramConfig(): Promise<TelegramConfig> {
  note(
    'SECURITY: Telegram bots are public by default — anyone can DM your bot.\n' +
      'Set TELEGRAM_ALLOWED_USER_IDS to restrict access to your user ID only.\n\n' +
      'To find your user ID:\n' +
      '1. Open Telegram and search for @userinfobot\n' +
      '2. Send any message — it replies with your user ID (a number)',
    'Telegram Security'
  );

  note(
    'Telegram Bot Setup\n\n' +
      'Step 1: Create your bot\n' +
      '1. Open Telegram and search for @BotFather\n' +
      '2. Send /newbot\n' +
      '3. Choose a display name (e.g., "My Archon Bot")\n' +
      '4. Choose a username (must end in "bot")\n' +
      '5. Copy the token BotFather gives you',
    'Telegram Setup'
  );

  const botToken = await password({
    message: 'Enter your Telegram Bot Token:',
    validate: value => {
      if (!value?.includes(':')) {
        return 'Please enter a valid bot token (format: 123456:ABC...)';
      }
      return undefined;
    },
  });

  if (isCancel(botToken)) cancelSetup();

  // Do NOT set required: true — clack's text() blocks the enter key when
  // required is true and the value is empty, which traps the user. Validate
  // post-hoc with a warning instead.
  const allowedUserIds = await text({
    message: 'Enter allowed Telegram user IDs (comma-separated):',
    placeholder: '123456789,987654321',
  });

  if (isCancel(allowedUserIds)) cancelSetup();

  if (!allowedUserIds?.trim()) {
    log.warning(
      'No allowlist set — your Telegram bot will accept messages from ANYONE.\n' +
        'Add TELEGRAM_ALLOWED_USER_IDS to ~/.archon/.env after setup to restrict access.'
    );
  }

  return {
    botToken,
    allowedUserIds: allowedUserIds || '',
  };
}

/**
 * Collect Slack credentials
 */
async function collectSlackConfig(): Promise<SlackConfig> {
  note(
    'Slack App Setup\n\n' +
      'Slack setup requires creating an app at api.slack.com/apps\n\n' +
      '1. Create a new app "From scratch"\n' +
      '2. Enable Socket Mode:\n' +
      '   - Settings -> Socket Mode -> Enable\n' +
      '   - Generate an App-Level Token (xapp-...)\n' +
      '3. Add Bot Token Scopes (OAuth & Permissions):\n' +
      '   - app_mentions:read, chat:write, channels:history\n' +
      '   - channels:join, im:history, im:write, im:read\n' +
      '4. Subscribe to Bot Events (Event Subscriptions):\n' +
      '   - app_mention, message.im\n' +
      '5. Install to Workspace\n' +
      '   - Copy the Bot User OAuth Token (xoxb-...)\n' +
      '6. Invite bot to your channel: /invite @YourBotName\n\n' +
      'Get your user ID: Click profile -> ... -> Copy member ID',
    'Slack Setup'
  );

  const botToken = await password({
    message: 'Enter your Slack Bot Token (xoxb-...):',
    validate: value => {
      if (!value?.startsWith('xoxb-')) {
        return 'Please enter a valid bot token (starts with xoxb-)';
      }
      return undefined;
    },
  });

  if (isCancel(botToken)) cancelSetup();

  const appToken = await password({
    message: 'Enter your Slack App Token (xapp-...):',
    validate: value => {
      if (!value?.startsWith('xapp-')) {
        return 'Please enter a valid app token (starts with xapp-)';
      }
      return undefined;
    },
  });

  if (isCancel(appToken)) cancelSetup();

  const allowedUserIds = await text({
    message: 'Enter allowed Slack user IDs (comma-separated, or leave empty for all):',
    placeholder: 'U12345678,U87654321',
  });

  if (isCancel(allowedUserIds)) cancelSetup();

  return {
    botToken,
    appToken,
    allowedUserIds: allowedUserIds || '',
  };
}

/**
 * Collect bot display name
 */
async function collectBotDisplayName(): Promise<string> {
  const customName = await confirm({
    message: 'Do you want to set a custom bot display name? (Default: Archon)',
  });

  if (isCancel(customName)) cancelSetup();

  if (!customName) {
    return 'Archon';
  }

  const name = await text({
    message: 'Enter the bot display name:',
    placeholder: 'Archon',
    validate: value => {
      if (!value) return 'Name is required';
      return undefined;
    },
  });

  if (isCancel(name)) cancelSetup();

  return name;
}

// =============================================================================
// File Generation and Writing
// =============================================================================

/**
 * Result of attempting to bootstrap project-scoped Archon config.
 *  - `created`: `.archon/config.yaml` did not exist; we wrote a starter.
 *  - `existed`: file already present; left untouched (idempotent re-run).
 *  - `failed`: mkdir or write failed (permissions, read-only FS, etc.).
 *    Setup continues — the user can hand-create the file later.
 */
export type BootstrapProjectConfigResult =
  | { state: 'created'; path: string }
  | { state: 'existed'; path: string }
  | { state: 'failed'; path: string; error: string };

/**
 * Create `<projectPath>/.archon/config.yaml` with a commented-out template if
 * absent. Pairs with the skill install — gives the user a place to put
 * per-project overrides without manual mkdir. Workflows/commands/scripts
 * subdirs are intentionally not created; empty directories would clutter
 * users' trees and Archon's loaders handle their absence cleanly.
 */
export function bootstrapProjectConfig(projectPath: string): BootstrapProjectConfigResult {
  const archonDir = join(projectPath, '.archon');
  const configPath = join(archonDir, 'config.yaml');
  try {
    mkdirSync(archonDir, { recursive: true });
    // `wx` flag = exclusive create. Atomic against a concurrent create between
    // a check and a write, so an in-flight user edit is never overwritten.
    writeFileSync(
      configPath,
      [
        '# Project-scoped Archon config',
        '# Inherits defaults from ~/.archon/config.yaml.',
        '# Reference: https://archon.diy/reference/configuration/',
        '#',
        '# Examples:',
        '#   assistants:',
        '#     claude:',
        '#       model: sonnet',
        '#   docs:',
        '#     path: docs',
        '',
      ].join('\n'),
      { mode: 0o644, flag: 'wx' }
    );
    return { state: 'created', path: configPath };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') {
      return { state: 'existed', path: configPath };
    }
    return {
      state: 'failed',
      path: configPath,
      error: e.message,
    };
  }
}

// =============================================================================
// Terminal Spawning
// =============================================================================

/**
 * Try to spawn a process, catching both sync and async errors
 * Returns true if spawn succeeded, false if it failed
 */
function trySpawn(
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' }
): boolean {
  try {
    const child: ChildProcess = spawn(command, args, options);
    // Check if spawn failed immediately (child.pid will be undefined)
    if (!child.pid) {
      return false;
    }
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a new terminal window with the setup command on Windows
 * Tries: Windows Terminal -> cmd.exe with start
 */
function spawnWindowsTerminal(repoPath: string, command: string): SpawnResult {
  // Try Windows Terminal first (modern Windows 10/11)
  if (
    trySpawn('wt.exe', ['-d', repoPath, 'cmd', '/k', command], {
      detached: true,
      stdio: 'ignore',
    })
  ) {
    return { success: true };
  }

  // Fallback to cmd.exe with start command (works on all Windows)
  if (
    trySpawn('cmd.exe', ['/c', 'start', '""', '/D', repoPath, 'cmd', '/k', command], {
      detached: true,
      stdio: 'ignore',
    })
  ) {
    return { success: true };
  }

  return { success: false, error: 'Could not open terminal. Please run `archon setup` manually.' };
}

/**
 * Spawn terminal on macOS
 * Uses osascript to open Terminal.app (works with default terminal)
 */
function spawnMacTerminal(repoPath: string, command: string): SpawnResult {
  // Escape single quotes in path for AppleScript
  const escapedPath = repoPath.replace(/'/g, "'\"'\"'");
  const script = `tell application "Terminal" to do script "cd '${escapedPath}' && ${command}"`;

  if (trySpawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' })) {
    return { success: true };
  }

  return { success: false, error: 'Could not open Terminal. Please run `archon setup` manually.' };
}

/**
 * Spawn terminal on Linux
 * Tries: x-terminal-emulator -> gnome-terminal -> konsole -> xterm
 */
function spawnLinuxTerminal(repoPath: string, command: string): SpawnResult {
  const setupCmd = `${command}; exec bash`;

  // Try x-terminal-emulator first (Debian/Ubuntu default)
  if (
    trySpawn(
      'x-terminal-emulator',
      ['--working-directory=' + repoPath, '-e', `bash -c "${setupCmd}"`],
      {
        detached: true,
        stdio: 'ignore',
      }
    )
  ) {
    return { success: true };
  }

  // Try gnome-terminal (GNOME)
  if (
    trySpawn('gnome-terminal', ['--working-directory=' + repoPath, '--', 'bash', '-c', setupCmd], {
      detached: true,
      stdio: 'ignore',
    })
  ) {
    return { success: true };
  }

  // Try konsole (KDE)
  if (
    trySpawn('konsole', ['--workdir', repoPath, '-e', 'bash', '-c', setupCmd], {
      detached: true,
      stdio: 'ignore',
    })
  ) {
    return { success: true };
  }

  // Try xterm (fallback, available on most systems)
  if (
    trySpawn('xterm', ['-e', `cd "${repoPath}" && ${setupCmd}`], {
      detached: true,
      stdio: 'ignore',
    })
  ) {
    return { success: true };
  }

  return {
    success: false,
    error: 'Could not find a terminal emulator. Please run `archon setup` manually.',
  };
}

/**
 * Spawn a new terminal window with archon setup
 */
export function spawnTerminalWithSetup(
  repoPath: string,
  providers?: readonly string[]
): SpawnResult {
  if (providers?.some(id => !isMaintainedProvider(id)))
    throw new Error('Invalid setup provider selection');
  const command = `archon setup${providers === undefined ? '' : ` --providers=${providers.join(',')}`}`;
  const platform = process.platform;

  if (platform === 'win32') {
    return spawnWindowsTerminal(repoPath, command);
  } else if (platform === 'darwin') {
    return spawnMacTerminal(repoPath, command);
  } else {
    return spawnLinuxTerminal(repoPath, command);
  }
}

// =============================================================================
// Main Setup Command
// =============================================================================

/**
 * Main setup command entry point. Resolves to the process exit code.
 */
export async function setupCommand(options: SetupOptions): Promise<number> {
  try {
    await runSetup(options);
    return 0;
  } catch (error) {
    if (error instanceof SetupExit) return error.exitCode;
    throw error;
  }
}

async function runSetup(options: SetupOptions): Promise<void> {
  // Handle --spawn flag
  if (options.spawn) {
    console.log('Opening setup wizard in a new terminal window...');
    const result = spawnTerminalWithSetup(options.repoPath, options.providers);

    if (result.success) {
      console.log('Setup wizard opened. Complete the setup in the new terminal window.');
    } else {
      console.log('');
      console.log('Next step: run the setup wizard in a separate terminal.');
      console.log('');
      console.log(
        `    cd ${options.repoPath} && archon setup${options.providers === undefined ? '' : ` --providers=${options.providers.join(',')}`}`
      );
      console.log('');
      console.log(
        'Come back here and let me know when you finish so I can verify your configuration.'
      );
    }
    return;
  }

  // Interactive setup flow
  intro('Archon Setup Wizard');

  // Resolve scope + target path up-front so everything downstream (existing-
  // config check, merge, write) agrees on which file we're touching.
  const scope: 'home' | 'project' = options.scope ?? 'home';
  const force = options.force ?? false;
  const targetEnvPath = resolveScopedEnvPath(scope, options.repoPath);

  // If a pre-existing <repo>/.env is present, tell the operator once that
  // archon does NOT manage it — avoids confusion for users upgrading from
  // versions that used to write there.
  const legacyRepoEnv = join(options.repoPath, '.env');
  if (existsSync(legacyRepoEnv)) {
    log.info(
      `Note: ${legacyRepoEnv} exists but is not managed by archon.\n` +
        '      Values there are stripped from the archon process at runtime (safety guard).\n' +
        '      Put archon env vars in ~/.archon/.env (home scope) or ' +
        `${join(options.repoPath, '.archon', '.env')} (project scope).`
    );
  }

  // Check for existing configuration at the selected scope (not unconditionally
  // ~/.archon/.env) so the Add/Update/Fresh decision reflects the actual target.
  const existing = checkExistingConfig(targetEnvPath);

  type SetupMode = 'fresh' | 'add' | 'update';
  let mode: SetupMode = 'fresh';

  if (existing) {
    const configuredPlatforms: string[] = [];
    if (existing.platforms.github) configuredPlatforms.push('GitHub');
    if (existing.platforms.telegram) configuredPlatforms.push('Telegram');
    if (existing.platforms.slack) configuredPlatforms.push('Slack');

    const summary = [
      `Claude: ${existing.hasClaude ? 'Configured' : 'Not configured'}`,
      `Codex: ${existing.hasCodex ? 'Configured' : 'Not configured'}`,
      `Pi: ${existing.hasPi ? 'Configured' : 'Not configured'}`,
      `Platforms: ${configuredPlatforms.length > 0 ? configuredPlatforms.join(', ') : 'None'}`,
    ].join('\n');

    note(summary, 'Existing Configuration Found');

    const modeChoice = await select({
      message: 'What would you like to do?',
      options: [
        {
          value: 'add',
          label: 'Add providers or platforms',
          hint: force
            ? 'Re-enter existing platform credentials and configure additions before replacing the file'
            : 'Keep existing credentials, configure selected providers and new platforms',
        },
        { value: 'update', label: 'Update config', hint: 'Modify existing settings' },
        { value: 'fresh', label: 'Start fresh', hint: 'Replace all configuration' },
      ],
    });

    if (isCancel(modeChoice)) cancelSetup();

    mode = modeChoice as SetupMode;
  }

  // Collect configuration based on mode
  const s = spinner();
  const ai = await collectAIConfig(options);

  let config: SetupConfig;

  if (mode === 'add') {
    s.start('Loading existing configuration...');

    config = {
      ai,
      platforms: {
        github: existing?.platforms.github ?? false,
        telegram: existing?.platforms.telegram ?? false,
        slack: existing?.platforms.slack ?? false,
      },
      botDisplayName: 'Archon',
    };

    s.stop('Existing configuration loaded');

    // Collect only new platforms
    log.info('Select additional platforms to configure');
    const newPlatforms = await collectPlatforms();

    // Merge with existing
    config.platforms = {
      github: config.platforms.github || newPlatforms.github,
      telegram: config.platforms.telegram || newPlatforms.telegram,
      slack: config.platforms.slack || newPlatforms.slack,
    };

    if (force) {
      log.info('--force replaces the env file. Re-enter credentials for all configured platforms.');
    }

    if (config.platforms.github && (force || !existing?.platforms.github)) {
      config.github = await collectGitHubConfig();
    }
    if (config.platforms.telegram && (force || !existing?.platforms.telegram)) {
      config.telegram = await collectTelegramConfig();
    }
    if (config.platforms.slack && (force || !existing?.platforms.slack)) {
      config.slack = await collectSlackConfig();
    }
  } else {
    const platforms = await collectPlatforms();

    config = {
      ai,
      platforms,
      botDisplayName: 'Archon',
    };

    // Collect platform credentials
    if (platforms.github) {
      config.github = await collectGitHubConfig();
    }
    if (platforms.telegram) {
      config.telegram = await collectTelegramConfig();
    }
    if (platforms.slack) {
      config.slack = await collectSlackConfig();
    }

    // Collect bot display name
    config.botDisplayName = await collectBotDisplayName();
  }

  let replaceGitHubAuth = false;
  const otherEnvPath = resolveScopedEnvPath(
    scope === 'home' ? 'project' : 'home',
    options.repoPath
  );
  const otherGitHubEnv =
    otherEnvPath !== targetEnvPath && existsSync(otherEnvPath)
      ? parseDotenv(readFileSync(otherEnvPath, 'utf8'))
      : {};
  const saved = existsSync(targetEnvPath) ? parseDotenv(readFileSync(targetEnvPath, 'utf8')) : {};
  if (!force && !config.github && selectGitHubAuthMode(saved).kind === 'conflict') {
    cancel(
      `Conflicting GitHub authentication in ${targetEnvPath}. Select GitHub to resolve the conflict. No env files were changed.`
    );
    exitSetup(1);
  }
  if (config.platforms.github) {
    const githubMode = config.github?.mode ?? selectGitHubAuthMode(saved).kind;
    if (otherEnvPath !== targetEnvPath && existsSync(otherEnvPath)) {
      const other = otherGitHubEnv;
      const conflictingKeys = githubMode === 'app' ? GITHUB_PAT_KEYS : GITHUB_APP_CREDENTIAL_KEYS;
      if (conflictingKeys.some(key => other[key])) {
        cancel(
          `Conflicting GitHub authentication in ${otherEnvPath}. Remove the other mode's credentials there before running setup again. No env files were changed.`
        );
        exitSetup(1);
      }
    }
    const oppositeKeys = githubMode === 'app' ? GITHUB_PAT_KEYS : GITHUB_APP_CREDENTIAL_KEYS;
    const replacePartialApp =
      config.github?.mode === 'app' &&
      !hasCompleteAppCredential(saved) &&
      GITHUB_APP_CREDENTIAL_KEYS.some(key => Boolean(saved[key]));
    if (config.github && (oppositeKeys.some(key => Boolean(saved[key])) || replacePartialApp)) {
      const approved = await confirm({
        message: `Replace existing GitHub authentication with ${config.github.mode === 'app' ? 'GitHub App' : 'personal access token'} mode? A backup will be saved.`,
        initialValue: false,
      });
      if (isCancel(approved) || !approved) {
        cancel('Setup cancelled. Existing configuration was not changed.');
        exitSetup(0);
      }
      replaceGitHubAuth = true;
    }
  }

  // Generate and write configuration. Wrap in try/catch so any fs exception
  // (permission denied, read-only FS, backup copy failure, etc.) stops the
  // spinner cleanly and surfaces an actionable error instead of a raw stack
  // trace after the user has filled out the entire wizard.
  s.start('Writing configuration...');

  let writeResult: ReturnType<typeof writeScopedEnv>;
  try {
    const envContent = generateEnvContent(config);
    const selected = parseDotenv(
      !force && existsSync(targetEnvPath)
        ? mergeScopedEnv(envContent, readFileSync(targetEnvPath, 'utf8'), replaceGitHubAuth).content
        : envContent
    );
    const inheritedEnv = options.inheritedEnv ?? process.env;
    const effective = {
      ...inheritedEnv,
      ...(scope === 'project' ? otherGitHubEnv : selected),
      ...(scope === 'project' ? selected : otherGitHubEnv),
    };
    const mode = selectGitHubAuthMode(effective);
    if (config.github?.mode === 'pat' && mode.kind !== 'pat') {
      throw new Error(
        mode.kind === 'conflict'
          ? mode.message
          : 'Effective GitHub configuration does not activate PAT mode. Check GITHUB_TOKEN and WEBHOOK_SECRET in the environment and both Archon env files.'
      );
    }
    if (
      config.github?.mode === 'app' ||
      (!config.github &&
        mode.kind !== 'pat' &&
        [inheritedEnv, otherGitHubEnv, force ? {} : saved].some(layer =>
          GITHUB_APP_CREDENTIAL_KEYS.some(key => Boolean(layer[key]))
        ))
    ) {
      if (mode.kind !== 'app') {
        throw new Error(
          mode.kind === 'conflict'
            ? mode.message
            : 'Effective GitHub configuration does not activate App mode. Check App ID, private key, and webhook secret in the environment and both Archon env files.'
        );
      }
      if (!loadGitHubAppConfig(effective)) {
        throw new Error('Effective GitHub App configuration could not be loaded.');
      }
    }
    writeResult = writeScopedEnv(envContent, {
      scope,
      repoPath: options.repoPath,
      force,
      replaceGitHubAuth,
    });
  } catch (error) {
    s.stop('Failed to write configuration');
    const err = error as NodeJS.ErrnoException;
    const code = err.code ? ` (${err.code})` : '';
    cancel(`Could not write ${targetEnvPath}${code}: ${err.message}`);
    exitSetup(1);
  }

  s.stop('Configuration written');

  // Pi model ref lives in ~/.archon/config.yaml, not the .env file, because
  // it's a structured user preference rather than a secret.
  if (config.ai.pi && config.ai.piModel) {
    try {
      writeHomePiModelConfig(config.ai.piModel);
    } catch (err) {
      // Non-fatal: env write already succeeded, so the user can hand-edit
      // ~/.archon/config.yaml later. Surface the error so it's not silent.
      const e = err as NodeJS.ErrnoException;
      const code = e.code ? ` (${e.code})` : '';
      log.warning(`Could not write Pi model config: ${e.message}${code}`);
      getLog().warn({ err: e }, 'setup.pi_model_config_write_failed');
    }
  }

  // Default assistant (+ optional chat model) → ~/.archon/config.yaml through
  // the SAME install-scope write path as `archon ai default <provider>
  // [<model>]` (#1998/#1999). Must run AFTER the Pi block above:
  // writeHomePiModelConfig refuses to append once an `assistants:` block
  // exists, and updateGlobalConfig can materialize one — the merge-write here
  // preserves whatever the Pi writer produced.
  await writeInstallDefaults(config.ai);

  // Model tiers: confirm built-in defaults (claude/codex) or point providers
  // without built-ins at the owning config surfaces before anything runs.
  if (config.ai.defaultAssistant !== undefined) await confirmModelTiers(config.ai.defaultAssistant);

  // Tell the operator exactly what happened — especially that <repo>/.env was
  // NOT touched, because prior versions wrote there and this is the biggest
  // behavior change for returning users.
  if (writeResult.preservedKeys.length > 0) {
    log.info(
      `Preserved ${writeResult.preservedKeys.length} existing value(s) (use --force to overwrite): ${writeResult.preservedKeys.join(', ')}`
    );
  }
  if (writeResult.backupPath) {
    log.info(`Backup written to ${writeResult.backupPath}`);
  }

  // Offer to install the Archon skill
  const shouldCopySkill = await confirm({
    message: 'Install the Archon skill in your project? (recommended)',
    initialValue: true,
  });

  if (isCancel(shouldCopySkill)) cancelSetup();

  let skillInstalledPath: string | null = null;
  let skillInstalledBase: string | null = null;
  let projectConfigCreatedPath: string | null = null;

  if (shouldCopySkill) {
    const skillTargetRaw = await text({
      message: 'Project path to install the skill:',
      defaultValue: options.repoPath,
      placeholder: options.repoPath,
    });

    if (isCancel(skillTargetRaw)) cancelSetup();

    s.start('Installing Archon skill...');
    try {
      await copyArchonSkill(skillTargetRaw);
    } catch (err) {
      s.stop('Archon skill installation failed');
      cancel(`Could not install skill: ${(err as NodeJS.ErrnoException).message}`);
      exitSetup(1);
    }
    s.stop('Archon skill installed');
    skillInstalledBase = skillTargetRaw;
    skillInstalledPath = join(skillTargetRaw, '.claude', 'skills', 'archon-cli');

    const bootstrapResult = bootstrapProjectConfig(skillTargetRaw);
    if (bootstrapResult.state === 'created') {
      log.info(`Created project config: ${bootstrapResult.path}`);
      projectConfigCreatedPath = bootstrapResult.path;
    } else if (bootstrapResult.state === 'failed') {
      // Non-fatal — log so silent permission errors don't masquerade as a
      // successful setup. The user can hand-create the file later.
      log.warn(`Could not create ${bootstrapResult.path}: ${bootstrapResult.error}`);
    }
  }

  // Optional: configure docs directory
  const wantsDocsPath = await confirm({
    message: 'Configure a non-default docs directory? (default: docs/)',
    initialValue: false,
  });

  if (!isCancel(wantsDocsPath) && wantsDocsPath) {
    const docsPath = await text({
      message: 'Where are your project docs? (relative to repo root)',
      placeholder: 'docs/',
    });

    if (!isCancel(docsPath) && typeof docsPath === 'string' && docsPath.trim()) {
      try {
        const archonDir = join(options.repoPath, '.archon');
        mkdirSync(archonDir, { recursive: true });
        const configPath = join(archonDir, 'config.yaml');
        const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
        if (!existing.includes('docs:')) {
          const escaped = docsPath.trim().replace(/"/g, '\\"');
          writeFileSync(configPath, existing + `\ndocs:\n  path: "${escaped}"\n`);
        } else {
          note(
            `A "docs:" key already exists in ${configPath}.\nEdit it manually to set path: ${docsPath.trim()}`,
            'Docs path not written'
          );
        }
      } catch (err) {
        cancel(`Could not write docs config: ${(err as NodeJS.ErrnoException).message}`);
        exitSetup(1);
      }
    }
  }

  // Summary
  const configuredPlatforms: string[] = [];
  if (config.platforms.github) configuredPlatforms.push('GitHub');
  if (config.platforms.telegram) configuredPlatforms.push('Telegram');
  if (config.platforms.slack) configuredPlatforms.push('Slack');

  const aiConfigured: string[] = [];
  if (config.ai.claude) {
    const authMethod =
      config.ai.claudeAuthType === 'global'
        ? 'global auth'
        : config.ai.claudeAuthType === 'apiKey'
          ? 'API key'
          : 'OAuth token';
    aiConfigured.push(`Claude (${authMethod})`);
  }
  if (config.ai.codex && config.ai.codexTokens) {
    aiConfigured.push('Codex');
  }
  if (config.ai.pi) {
    aiConfigured.push(config.ai.piApiKey ? `Pi (${config.ai.piApiKeyEnvVar})` : 'Pi');
  }

  const summaryLines = [
    `AI: ${aiConfigured.length > 0 ? aiConfigured.join(', ') : 'None configured'}`,
    `Default: ${config.ai.defaultAssistant ?? 'unset'}${config.ai.defaultModel ? ` (chat model: ${config.ai.defaultModel})` : ''}`,
    `Platforms: ${configuredPlatforms.length > 0 ? configuredPlatforms.join(', ') : 'None (CLI + skill only)'}`,
    '',
    `File written (${scope} scope):`,
    `  ${writeResult.targetPath}`,
  ];

  if (config.platforms.github && config.github) {
    summaryLines.push('');
    summaryLines.push('GitHub Webhook Setup:');
    summaryLines.push(
      `  Use WEBHOOK_SECRET from ${writeResult.targetPath} in your GitHub webhook configuration.`
    );
  }

  if (skillInstalledPath && skillInstalledBase) {
    const codexInstalledPath = join(skillInstalledBase, '.agents', 'skills', 'archon-cli');
    summaryLines.push('');
    summaryLines.push('Archon skill installed:');
    summaryLines.push(`  ${skillInstalledPath}  (Claude Code)`);
    summaryLines.push(`  ${codexInstalledPath}  (Codex)`);
    if (projectConfigCreatedPath) {
      summaryLines.push('');
      summaryLines.push('Project config created:');
      summaryLines.push(`  ${projectConfigCreatedPath}`);
    }
  }

  note(summaryLines.join('\n'), 'Configuration Complete');

  // Additional options note
  note(
    'Other settings you can customize in ~/.archon/.env:\n' +
      '  - PORT (default: 3090)\n' +
      '  - MAX_CONCURRENT_CONVERSATIONS (default: 10)\n' +
      '  - *_STREAMING_MODE (stream | batch per platform)\n\n' +
      'These defaults work well for most users.',
    'Additional Options'
  );

  note(
    'To update Archon:\n' +
      '  Homebrew:  brew upgrade coleam00/archon/archon\n' +
      '  curl:      curl -fsSL https://raw.githubusercontent.com/coleam00/Archon/main/scripts/install.sh | bash\n' +
      '  Docker:    docker pull ghcr.io/coleam00/archon:latest',
    'Update Instructions'
  );

  const runDoctor = await confirm({
    message: 'Run `archon doctor` now to verify your setup?',
    initialValue: true,
  });
  if (!isCancel(runDoctor) && runDoctor) {
    const { doctorCommand } = await import('./doctor');
    const { loadCliEnv } = await import('../load-cli-env');
    await loadCliEnv(process.cwd());
    await doctorCommand();
  }

  outro('Setup complete!');
}
