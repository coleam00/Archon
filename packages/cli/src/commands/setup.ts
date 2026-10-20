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
  select,
  confirm,
  note,
  spinner,
  isCancel,
  cancel,
  log,
} from '@clack/prompts';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { type Document, isScalar, parseDocument, Scalar, YAMLMap } from 'yaml';
import { copyArchonSkill } from './skill';
import {
  SetupExit,
  cancelSetup,
  exitSetup,
  getLog,
  type SetupConfig,
  type SetupOptions,
} from './setup-shared';
import { writeHomePiModelConfig } from './setup-provider-auth';
import {
  checkExistingConfig,
  generateEnvContent,
  resolveScopedEnvPath,
  writeScopedEnv,
} from './setup-env';
import { collectAIConfig, confirmModelTiers, writeInstallDefaults } from './setup-ai';
import {
  assertEffectiveGitHubAuth,
  collectGitHubConfig,
  reconcileGitHubAuth,
} from './setup-github';
import {
  collectBotDisplayName,
  collectPlatforms,
  collectSlackConfig,
  collectTelegramConfig,
} from './setup-platforms';
import { spawnTerminalWithSetup } from './setup-spawn';

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
  if (options.spawn) {
    await openSetupTerminal(options);
    return;
  }

  intro('Archon Setup Wizard');

  const scope = options.scope ?? 'home';
  const force = options.force ?? false;
  const targetEnvPath = resolveScopedEnvPath(scope, options.repoPath);
  const target = { scope, force, repoPath: options.repoPath, targetEnvPath };

  reportLegacyRepoEnv(options.repoPath);
  const existing = checkExistingConfig(targetEnvPath);
  const mode = await selectSetupMode(existing, force);
  const s = spinner();
  const ai = await collectAIConfig(options);
  let config: SetupConfig;
  if (mode === 'add') {
    config = await collectAdditionalConfig(ai, existing, force, s);
  } else {
    const platforms = await collectPlatforms();
    config = { ai, platforms, botDisplayName: 'Archon' };
    await collectPlatformCredentials(config, platforms);
    config.botDisplayName = await collectBotDisplayName();
  }
  const writeResult = await writeConfiguration(
    config,
    target,
    options.inheritedEnv ?? process.env,
    s
  );

  writePiModelPreference(config.ai);
  // The Pi writer must run first: it refuses to append once an assistants block
  // exists, and writeInstallDefaults can materialize that block.
  await writeInstallDefaults(config.ai);
  if (config.ai.defaultAssistant !== undefined) await confirmModelTiers(config.ai.defaultAssistant);
  reportEnvWrite(writeResult);

  const installation = await installProjectSkill(options.repoPath, s);
  await configureDocsPath(installation.projectPath);
  showSetupSummary(config, scope, writeResult.targetPath, installation);
  await finishSetup();
}

async function openSetupTerminal(options: SetupOptions): Promise<void> {
  console.log('Opening setup wizard in a new terminal window...');
  const result = await spawnTerminalWithSetup(options.repoPath, options.providers);

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
}

function reportLegacyRepoEnv(repoPath: string): void {
  const legacyRepoEnv = join(repoPath, '.env');
  if (existsSync(legacyRepoEnv)) {
    log.info(
      `Note: ${legacyRepoEnv} exists but is not managed by archon.\n` +
        '      Values there are stripped from the archon process at runtime (safety guard).\n' +
        '      Put archon env vars in ~/.archon/.env (home scope) or ' +
        `${join(repoPath, '.archon', '.env')} (project scope).`
    );
  }
}

type SetupMode = 'fresh' | 'add' | 'update';
type ExistingConfig = ReturnType<typeof checkExistingConfig>;

async function selectSetupMode(existing: ExistingConfig, force: boolean): Promise<SetupMode> {
  if (!existing) return 'fresh';
  const platforms = platformNames(existing.platforms);
  const summary = [
    `Claude: ${existing.hasClaude ? 'Configured' : 'Not configured'}`,
    `Codex: ${existing.hasCodex ? 'Configured' : 'Not configured'}`,
    `Pi: ${existing.hasPi ? 'Configured' : 'Not configured'}`,
    `Platforms: ${platforms.length > 0 ? platforms.join(', ') : 'None'}`,
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

  return modeChoice;
}

function platformNames(platforms: SetupConfig['platforms']): string[] {
  const names: string[] = [];
  if (platforms.github) names.push('GitHub');
  if (platforms.telegram) names.push('Telegram');
  if (platforms.slack) names.push('Slack');
  return names;
}

async function collectAdditionalConfig(
  ai: SetupConfig['ai'],
  existing: ExistingConfig,
  force: boolean,
  s: ReturnType<typeof spinner>
): Promise<SetupConfig> {
  s.start('Loading existing configuration...');

  const config: SetupConfig = {
    ai,
    platforms: {
      github: existing?.platforms.github ?? false,
      telegram: existing?.platforms.telegram ?? false,
      slack: existing?.platforms.slack ?? false,
    },
    botDisplayName: 'Archon',
  };

  s.stop('Existing configuration loaded');

  log.info('Select additional platforms to configure');
  const newPlatforms = await collectPlatforms();

  config.platforms = {
    github: config.platforms.github || newPlatforms.github,
    telegram: config.platforms.telegram || newPlatforms.telegram,
    slack: config.platforms.slack || newPlatforms.slack,
  };

  if (force) {
    log.info('--force replaces the env file. Re-enter credentials for all configured platforms.');
  }

  await collectPlatformCredentials(config, {
    github: config.platforms.github && (force || !existing?.platforms.github),
    telegram: config.platforms.telegram && (force || !existing?.platforms.telegram),
    slack: config.platforms.slack && (force || !existing?.platforms.slack),
  });
  return config;
}

async function collectPlatformCredentials(
  config: SetupConfig,
  platforms: SetupConfig['platforms']
): Promise<void> {
  if (platforms.github) config.github = await collectGitHubConfig();
  if (platforms.telegram) config.telegram = await collectTelegramConfig();
  if (platforms.slack) config.slack = await collectSlackConfig();
}

async function writeConfiguration(
  config: SetupConfig,
  target: Parameters<typeof reconcileGitHubAuth>[1],
  inheritedEnv: NodeJS.ProcessEnv,
  s: ReturnType<typeof spinner>
): Promise<ReturnType<typeof writeScopedEnv>> {
  const { scope, force, repoPath, targetEnvPath } = target;
  const githubAuth = await reconcileGitHubAuth(config, target);

  s.start('Writing configuration...');

  let writeResult: ReturnType<typeof writeScopedEnv>;
  try {
    const envContent = generateEnvContent(config);
    assertEffectiveGitHubAuth(config, envContent, {
      scope,
      force,
      targetEnvPath,
      inheritedEnv,
      ...githubAuth,
    });
    writeResult = writeScopedEnv(envContent, {
      scope,
      repoPath,
      force,
      replaceGitHubAuth: githubAuth.replaceGitHubAuth,
    });
  } catch (error) {
    s.stop('Failed to write configuration');
    const err = error as NodeJS.ErrnoException;
    const code = err.code ? ` (${err.code})` : '';
    cancel(`Could not write ${targetEnvPath}${code}: ${err.message}`);
    exitSetup(1);
  }

  s.stop('Configuration written');

  return writeResult;
}

function writePiModelPreference(ai: SetupConfig['ai']): void {
  if (!ai.pi || !ai.piModel) return;
  try {
    writeHomePiModelConfig(ai.piModel);
  } catch (err) {
    // Non-fatal: env write already succeeded, so the user can hand-edit
    // ~/.archon/config.yaml later. Surface the error so it's not silent.
    const e = err as NodeJS.ErrnoException;
    const code = e.code ? ` (${e.code})` : '';
    log.warning(`Could not write Pi model config: ${e.message}${code}`);
    getLog().warn({ err: e }, 'setup.pi_model_config_write_failed');
  }
}

function reportEnvWrite(writeResult: ReturnType<typeof writeScopedEnv>): void {
  if (writeResult.preservedKeys.length > 0) {
    log.info(
      `Preserved ${writeResult.preservedKeys.length} existing value(s) (use --force to overwrite): ${writeResult.preservedKeys.join(', ')}`
    );
  }
  if (writeResult.backupPath) {
    log.info(`Backup written to ${writeResult.backupPath}`);
  }
}

function configuredProviderNames(ai: SetupConfig['ai']): string[] {
  const aiConfigured: string[] = [];
  if (ai.claude) {
    const authMethod =
      ai.claudeAuthType === 'global'
        ? 'global auth'
        : ai.claudeAuthType === 'apiKey'
          ? 'API key'
          : 'OAuth token';
    aiConfigured.push(`Claude (${authMethod})`);
  }
  if (ai.codex && ai.codexTokens) {
    aiConfigured.push('Codex');
  }
  if (ai.pi) {
    aiConfigured.push(ai.piApiKey ? `Pi (${ai.piApiKeyEnvVar})` : 'Pi');
  }

  return aiConfigured;
}

function showSetupSummary(
  config: SetupConfig,
  scope: NonNullable<SetupOptions['scope']>,
  targetPath: string,
  {
    skillInstalledPath,
    projectPath,
    projectConfigCreatedPath,
  }: Awaited<ReturnType<typeof installProjectSkill>>
): void {
  const platforms = platformNames(config.platforms);
  const aiConfigured = configuredProviderNames(config.ai);
  const summaryLines = [
    `AI: ${aiConfigured.length > 0 ? aiConfigured.join(', ') : 'None configured'}`,
    `Default: ${config.ai.defaultAssistant ?? 'unset'}${config.ai.defaultModel ? ` (chat model: ${config.ai.defaultModel})` : ''}`,
    `Platforms: ${platforms.length > 0 ? platforms.join(', ') : 'None (CLI + skill only)'}`,
    '',
    `File written (${scope} scope):`,
    `  ${targetPath}`,
  ];

  if (config.platforms.github && config.github) {
    summaryLines.push('');
    summaryLines.push('GitHub Webhook Setup:');
    summaryLines.push(
      `  Use WEBHOOK_SECRET from ${targetPath} in your GitHub webhook configuration.`
    );
  }

  if (skillInstalledPath) {
    const codexInstalledPath = join(projectPath, '.agents', 'skills', 'archon-cli');
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
}

async function finishSetup(): Promise<void> {
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

/**
 * Offer to install the Archon skill, and bootstrap `.archon/config.yaml`, in
 * a project the operator names. `projectPath` is that project, or `repoPath`
 * when the operator declines the install.
 */
async function installProjectSkill(
  repoPath: string,
  s: ReturnType<typeof spinner>
): Promise<{
  skillInstalledPath: string | null;
  projectPath: string;
  projectConfigCreatedPath: string | null;
}> {
  const shouldCopySkill = await confirm({
    message: 'Install the Archon skill in your project? (recommended)',
    initialValue: true,
  });

  if (isCancel(shouldCopySkill)) cancelSetup();

  let skillInstalledPath: string | null = null;
  let projectPath = repoPath;
  let projectConfigCreatedPath: string | null = null;

  if (shouldCopySkill) {
    const skillTargetRaw = await text({
      message: 'Project path to install the skill:',
      defaultValue: repoPath,
      placeholder: repoPath,
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
    projectPath = skillTargetRaw;
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

  return { skillInstalledPath, projectPath, projectConfigCreatedPath };
}

/**
 * Return `existing` config text with `docs.path` set, or null when a real `docs` key
 * already exists. Comments and other content are preserved.
 */
function withDocsPath(existing: string, docsPath: string): string | null {
  // Use the runtime loader's parser to resolve aliases, merges and complex keys.
  const parsed: unknown = Bun.YAML.parse(existing);
  if (parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'docs')) return null;

  const document: Document = parseDocument(existing, { uniqueKeys: false });
  if (document.errors.length > 0) throw document.errors[0];
  if (isScalar(document.contents) && document.contents.value === null) {
    const root = new YAMLMap(document.schema);
    root.commentBefore = document.contents.commentBefore;
    root.comment = document.contents.comment;
    root.spaceBefore = document.contents.spaceBefore;
    document.contents = root;
  }
  const path = new Scalar(docsPath);
  path.type = Scalar.QUOTE_DOUBLE;
  const docs = new YAMLMap(document.schema);
  docs.set('path', path);
  document.set('docs', docs);
  return document.toString();
}

/** Optionally record a non-default docs directory in `<repo>/.archon/config.yaml`. */
export async function configureDocsPath(repoPath: string): Promise<void> {
  const wantsDocsPath = await confirm({
    message: 'Configure a non-default docs directory? (default: docs/)',
    initialValue: false,
  });
  if (isCancel(wantsDocsPath) || !wantsDocsPath) return;

  const docsPath = await text({
    message: 'Where are your project docs? (relative to repo root)',
    placeholder: 'docs/',
  });
  if (isCancel(docsPath) || typeof docsPath !== 'string' || !docsPath.trim()) return;

  try {
    const archonDir = join(repoPath, '.archon');
    mkdirSync(archonDir, { recursive: true });
    const configPath = join(archonDir, 'config.yaml');
    const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
    const updated = withDocsPath(existing, docsPath.trim());
    if (updated !== null) {
      writeFileSync(configPath, updated);
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
