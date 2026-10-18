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
import { parse as parseDotenv } from 'dotenv';
import { join } from 'path';
import { loadGitHubAppConfig } from '@archon/core/github-auth/config';
import { copyArchonSkill } from './skill';
import { spawn, type ChildProcess } from 'child_process';
import {
  GITHUB_APP_CREDENTIAL_KEYS,
  GITHUB_PAT_KEYS,
  selectGitHubAuthMode,
} from '@archon/core/utils/github-auth-mode';
import { isMaintainedProvider } from '@archon/provider-contract';
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
  hasCompleteAppCredential,
  mergeScopedEnv,
  resolveScopedEnvPath,
  writeScopedEnv,
} from './setup-env';
import { collectAIConfig, confirmModelTiers, writeInstallDefaults } from './setup-ai';
import { collectGitHubConfig } from './setup-github';
import {
  collectBotDisplayName,
  collectPlatforms,
  collectSlackConfig,
  collectTelegramConfig,
} from './setup-platforms';

// =============================================================================
// Types
// =============================================================================

interface SpawnResult {
  success: boolean;
  error?: string;
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
