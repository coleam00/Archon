/**
 * The GitHub step of `archon setup`: choosing PAT or GitHub App
 * authentication and collecting its credentials, allowlist and webhook secret,
 * then reconciling that choice with the GitHub auth already in both Archon env
 * files and checking the mode the written configuration will activate.
 */
import {
  cancel,
  confirm,
  isCancel,
  log,
  note,
  password,
  select,
  spinner,
  text,
} from '@clack/prompts';
import { existsSync, readFileSync } from 'fs';
import { parse as parseDotenv, type DotenvParseOutput } from 'dotenv';
import { resolve } from 'path';
import { randomBytes, createPrivateKey } from 'crypto';
import { spawnSync } from 'child_process';
import { execFileAsync } from '@archon/git';
import { expandTilde } from '@archon/paths';
import { loadGitHubAppConfig } from '@archon/core/github-auth/config';
import {
  GITHUB_APP_CREDENTIAL_KEYS,
  GITHUB_PAT_KEYS,
  selectGitHubAuthMode,
} from '@archon/core/utils/github-auth-mode';
import {
  cancelSetup,
  exitSetup,
  type GitHubConfig,
  type SetupConfig,
  type SetupOptions,
} from './setup-shared';
import { hasCompleteAppCredential, mergeScopedEnv, resolveScopedEnvPath } from './setup-env';

/**
 * Generate a cryptographically secure webhook secret
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Collect GitHub credentials
 */
export async function collectGitHubConfig(): Promise<GitHubConfig> {
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

  await ensureGhCliAuth();
  const allowedUsers = await collectGitHubAllowedUsers();
  const botMention = await collectBotMention();

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
 * Probe `gh` CLI auth — workflows that shell out to `gh` (e.g. `gh issue
 * create`, `gh pr edit`) need this even if the PAT is set, because they call
 * the local `gh` binary, not the API directly.
 */
async function ensureGhCliAuth(): Promise<void> {
  const ghAuthError = await probeGhCliAuth();
  if (ghAuthError === undefined) return;
  log.warning(
    `gh auth check failed: ${ghAuthError}\n` +
      (ghAuthError.includes('not found') ? '' : 'Run: gh auth login')
  );
  // gh auth login is an interactive OAuth flow — only offer it from a TTY.
  if (process.stdout.isTTY) await offerGhAuthLogin();
}

/** Returns why `gh auth status` failed, or undefined when gh is authenticated. */
async function probeGhCliAuth(): Promise<string | undefined> {
  const ghSpin = spinner();
  ghSpin.start('Checking gh CLI authentication...');
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    ghSpin.stop('gh CLI is authenticated');
    return undefined;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    ghSpin.stop('gh CLI check failed');
    return e.code === 'ENOENT'
      ? 'gh not found in PATH — install it first (https://cli.github.com)'
      : (e.message ?? 'unknown error');
  }
}

async function offerGhAuthLogin(): Promise<void> {
  const runGhLogin = await confirm({
    message: 'Run `gh auth login` now?',
    initialValue: true,
  });
  if (isCancel(runGhLogin) || !runGhLogin) return;
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

async function collectBotMention(): Promise<string | undefined> {
  const customMention = await confirm({
    message: 'Do you want to set a custom @mention name? (Default: archon)',
  });

  if (isCancel(customMention)) cancelSetup();
  if (!customMention) return undefined;

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
  return mention;
}

/** What `reconcileGitHubAuth` found in the env files, read again by the write step. */
export interface GitHubAuthReconciliation {
  replaceGitHubAuth: boolean;
  otherGitHubEnv: DotenvParseOutput;
  saved: DotenvParseOutput;
}

function assertOtherScopeGitHubAuth(
  githubMode: ReturnType<typeof selectGitHubAuthMode>['kind'],
  otherEnvPath: string,
  targetEnvPath: string,
  otherGitHubEnv: DotenvParseOutput
): void {
  if (otherEnvPath !== targetEnvPath && existsSync(otherEnvPath)) {
    const conflictingKeys = githubMode === 'app' ? GITHUB_PAT_KEYS : GITHUB_APP_CREDENTIAL_KEYS;
    if (conflictingKeys.some(key => otherGitHubEnv[key])) {
      cancel(
        `Conflicting GitHub authentication in ${otherEnvPath}. Remove the other mode's credentials there before running setup again. No env files were changed.`
      );
      exitSetup(1);
    }
  }
}

async function confirmGitHubAuthReplacement(
  github: GitHubConfig,
  saved: DotenvParseOutput
): Promise<boolean> {
  const oppositeKeys = github.mode === 'app' ? GITHUB_PAT_KEYS : GITHUB_APP_CREDENTIAL_KEYS;
  const replacePartialApp =
    github.mode === 'app' &&
    !hasCompleteAppCredential(saved) &&
    GITHUB_APP_CREDENTIAL_KEYS.some(key => Boolean(saved[key]));
  if (oppositeKeys.some(key => Boolean(saved[key])) || replacePartialApp) {
    const approved = await confirm({
      message: `Replace existing GitHub authentication with ${github.mode === 'app' ? 'GitHub App' : 'personal access token'} mode? A backup will be saved.`,
      initialValue: false,
    });
    if (isCancel(approved) || !approved) {
      cancel('Setup cancelled. Existing configuration was not changed.');
      exitSetup(0);
    }
    return true;
  }
  return false;
}

/**
 * Check the collected GitHub choice against the GitHub auth already saved in
 * the target env file and the other scope's env file. Exits setup on a
 * conflict it cannot resolve, and asks before replacing the saved auth mode.
 */
export async function reconcileGitHubAuth(
  config: SetupConfig,
  {
    scope,
    force,
    repoPath,
    targetEnvPath,
  }: { scope: 'home' | 'project'; force: boolean; repoPath: string; targetEnvPath: string }
): Promise<GitHubAuthReconciliation> {
  let replaceGitHubAuth = false;
  const otherEnvPath = resolveScopedEnvPath(scope === 'home' ? 'project' : 'home', repoPath);
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
    assertOtherScopeGitHubAuth(githubMode, otherEnvPath, targetEnvPath, otherGitHubEnv);
    if (config.github) {
      replaceGitHubAuth = await confirmGitHubAuthReplacement(config.github, saved);
    }
  }
  return { replaceGitHubAuth, otherGitHubEnv, saved };
}

/**
 * Throw when the env that results from writing `envContent`, layered with the
 * inherited environment and the other scope's env file, would not activate
 * the GitHub auth mode setup configured.
 */
export function assertEffectiveGitHubAuth(
  config: SetupConfig,
  envContent: string,
  {
    scope,
    force,
    targetEnvPath,
    replaceGitHubAuth,
    inheritedEnv,
    otherGitHubEnv,
    saved,
  }: GitHubAuthReconciliation & {
    scope: 'home' | 'project';
    force: boolean;
    targetEnvPath: string;
    inheritedEnv: NonNullable<SetupOptions['inheritedEnv']>;
  }
): void {
  const selected = parseDotenv(
    !force && existsSync(targetEnvPath)
      ? mergeScopedEnv(envContent, readFileSync(targetEnvPath, 'utf8'), replaceGitHubAuth).content
      : envContent
  );
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
    assertEffectiveGitHubAppAuth(mode, effective);
  }
}

function assertEffectiveGitHubAppAuth(
  mode: ReturnType<typeof selectGitHubAuthMode>,
  effective: NodeJS.ProcessEnv
): void {
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
