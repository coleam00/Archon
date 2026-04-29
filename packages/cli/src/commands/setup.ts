/**
 * Setup command - Interactive CLI wizard for Archon credential configuration
 *
 * Guides users through configuring:
 * - Database (SQLite default vs PostgreSQL)
 * - AI assistants (Claude and/or Codex)
 * - Platform connections (GitHub, Telegram, Slack, Discord)
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
 * every rewrite. `--force` skips the merge (proposed wins) but still backs up.
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
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { getRegisteredProviders } from '@archon/providers';
import {
  getArchonEnvPath as pathsGetArchonEnvPath,
  getRepoArchonEnvPath as pathsGetRepoArchonEnvPath,
} from '@archon/paths';

// =============================================================================
// Types
// =============================================================================

interface SetupConfig {
  database: {
    type: 'sqlite' | 'postgresql';
    url?: string;
  };
  ai: {
    claude: boolean;
    claudeAuthType?: 'global' | 'apiKey' | 'oauthToken';
    claudeApiKey?: string;
    claudeOauthToken?: string;
    /** Absolute path to Claude Code SDK's cli.js. Written as CLAUDE_BIN_PATH
     *  in ~/.archon/.env. Required in compiled Archon binaries; harmless in dev. */
    claudeBinaryPath?: string;
    codex: boolean;
    codexTokens?: CodexTokens;
    defaultAssistant: string;
  };
  platforms: {
    github: boolean;
    telegram: boolean;
    slack: boolean;
    discord: boolean;
  };
  github?: GitHubConfig;
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  discord?: DiscordConfig;
  botDisplayName: string;
}

interface GitHubConfig {
  token: string;
  webhookSecret: string;
  allowedUsers: string;
  botMention?: string;
}

interface TelegramConfig {
  botToken: string;
  allowedUserIds: string;
}

interface SlackConfig {
  botToken: string;
  appToken: string;
  allowedUserIds: string;
}

interface DiscordConfig {
  botToken: string;
  allowedUserIds: string;
}

interface CodexTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

interface ExistingConfig {
  hasDatabase: boolean;
  hasClaude: boolean;
  hasCodex: boolean;
  platforms: {
    github: boolean;
    telegram: boolean;
    slack: boolean;
    discord: boolean;
  };
}

interface SetupOptions {
  spawn?: boolean;
  repoPath: string;
  /** Which archon-owned file to target. Default: 'home'. */
  scope?: 'home' | 'project';
  /** Skip merge and overwrite the target wholesale (backup still written). Default: false. */
  force?: boolean;
}

interface SpawnResult {
  success: boolean;
  error?: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the Archon home directory (typically ~/.archon)
 */
function getArchonHome(): string {
  const envHome = process.env.ARCHON_HOME;
  if (envHome) {
    if (envHome.startsWith('~')) {
      return join(homedir(), envHome.slice(1));
    }
    return envHome;
  }
  return join(homedir(), '.archon');
}

/**
 * Generate a cryptographically secure webhook secret
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Check if a file exists and has a non-empty value for a given key
 */
function hasEnvValue(content: string, key: string): boolean {
  const regex = new RegExp(`^${key}=(.+)$`, 'm');
  const match = content.match(regex);
  return match !== null && match[1].trim().length > 0;
}

/**
 * Check if a CLI command is available in PATH
 */
function isCommandAvailable(command: string): boolean {
  try {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${checkCmd} ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe wrappers — exported so tests can spy on each tier independently.
 * Direct imports of `existsSync` and `execSync` cannot be intercepted by
 * `spyOn` (esm rebinding limitation), so we route the probes through these
 * thin wrappers and let the test mock them in isolation.
 */
export function probeFileExists(path: string): boolean {
  return existsSync(path);
}

export function probeNpmRoot(): string | null {
  try {
    const out = execSync('npm root -g', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function probeWhichClaude(): string | null {
  try {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';
    const resolved = execSync(`${checkCmd} claude`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // On Windows, `where` can return multiple lines — take the first.
    const first = resolved.split(/\r?\n/)[0]?.trim();
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Try to locate the Claude Code executable on disk.
 *
 * Compiled Archon binaries need an explicit path because the Claude Agent
 * SDK's `import.meta.url` resolution is frozen to the build host's filesystem.
 * The SDK's `pathToClaudeCodeExecutable` accepts either:
 *   - A native compiled binary (from the curl/PowerShell/winget installers — current default)
 *   - A JS `cli.js` (from `npm install -g @anthropic-ai/claude-code` — older path)
 *
 * We probe the well-known install locations in order:
 *   1. Native installer (`~/.local/bin/claude` on macOS/Linux, `%USERPROFILE%\.local\bin\claude.exe` on Windows)
 *   2. npm global `cli.js`
 *   3. `which claude` / `where claude` — fallback if the user installed via Homebrew, winget, or a custom layout
 *
 * Returns null on total failure so the caller can prompt the user.
 * Detection is best-effort; the caller should let users override.
 *
 * Exported so the probe order can be tested directly by spying on the
 * tier wrappers above (`probeFileExists`, `probeNpmRoot`, `probeWhichClaude`).
 */
export function detectClaudeExecutablePath(): string | null {
  // 1. Native installer default location (primary Anthropic-recommended path)
  const nativePath =
    process.platform === 'win32'
      ? join(homedir(), '.local', 'bin', 'claude.exe')
      : join(homedir(), '.local', 'bin', 'claude');
  if (probeFileExists(nativePath)) return nativePath;

  // 2. npm global cli.js
  const npmRoot = probeNpmRoot();
  if (npmRoot) {
    const npmCliJs = join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js');
    if (probeFileExists(npmCliJs)) return npmCliJs;
  }

  // 3. Fallback: resolve via `which` / `where` (Homebrew, winget, custom layouts)
  const fromPath = probeWhichClaude();
  if (fromPath && probeFileExists(fromPath)) return fromPath;

  return null;
}

/**
 * Get Node.js version if installed, or null if not
 */
function getNodeVersion(): { major: number; minor: number; patch: number } | null {
  try {
    const output = execSync('node --version', { encoding: 'utf-8' }).trim();
    // Output is like "v18.17.0" or "v22.1.0"
    const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(output);
    if (match) {
      return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * CLI installation instructions
 */
const CLI_INSTALL_INSTRUCTIONS = {
  claude: {
    name: 'Claude Code',
    checkCommand: 'claude',
    instructions: `Claude Code CLI is not installed.

Install using one of these methods:

  Recommended (native installer):
    curl -fsSL https://claude.ai/install.sh | bash

  Or via npm:
    npm install -g @anthropic-ai/claude-code

After installation, run: claude /login`,
  },
  codex: {
    name: 'Codex CLI',
    checkCommand: 'codex',
    instructions:
      process.platform === 'darwin'
        ? `Codex CLI is not installed.

Install using one of these methods:

  Recommended for macOS (no Node.js required):
    brew install codex

  Or via npm (requires Node.js 18+):
    npm install -g @openai/codex

After installation, run 'codex' to authenticate.`
        : `Codex CLI is not installed.

Install via npm:
    npm install -g @openai/codex

Requires Node.js 18 or later.
After installation, run 'codex' to authenticate.`,
  },
};

/**
 * Check for existing configuration at the selected scope's archon-owned env
 * file. Defaults to home scope for backward compatibility — callers writing to
 * project scope must pass a path so the Add/Update/Fresh decision reflects the
 * actual target.
 */
export function checkExistingConfig(envPath?: string): ExistingConfig | null {
  const path = envPath ?? join(getArchonHome(), '.env');

  if (!existsSync(path)) {
    return null;
  }

  const content = readFileSync(path, 'utf-8');

  return {
    hasDatabase: hasEnvValue(content, 'DATABASE_URL'),
    hasClaude:
      hasEnvValue(content, 'CLAUDE_API_KEY') ||
      hasEnvValue(content, 'CLAUDE_CODE_OAUTH_TOKEN') ||
      hasEnvValue(content, 'CLAUDE_USE_GLOBAL_AUTH'),
    hasCodex:
      hasEnvValue(content, 'CODEX_ID_TOKEN') &&
      hasEnvValue(content, 'CODEX_ACCESS_TOKEN') &&
      hasEnvValue(content, 'CODEX_REFRESH_TOKEN') &&
      hasEnvValue(content, 'CODEX_ACCOUNT_ID'),
    platforms: {
      github: hasEnvValue(content, 'GITHUB_TOKEN') || hasEnvValue(content, 'GH_TOKEN'),
      telegram: hasEnvValue(content, 'TELEGRAM_BOT_TOKEN'),
      slack: hasEnvValue(content, 'SLACK_BOT_TOKEN') && hasEnvValue(content, 'SLACK_APP_TOKEN'),
      discord: hasEnvValue(content, 'DISCORD_BOT_TOKEN'),
    },
  };
}

// =============================================================================
// Data Collection Functions
// =============================================================================

/**
 * Collect database configuration
 */
async function collectDatabaseConfig(): Promise<SetupConfig['database']> {
  const dbType = await select({
    message: 'Which database do you want to use?',
    options: [
      {
        value: 'sqlite',
        label: 'SQLite (default - no setup needed)',
        hint: 'Recommended for single user',
      },
      { value: 'postgresql', label: 'PostgreSQL', hint: 'For server deployments' },
    ],
  });

  if (isCancel(dbType)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  if (dbType === 'postgresql') {
    const url = await text({
      message: 'Enter your PostgreSQL connection string:',
      placeholder: 'postgresql://user:pass@localhost:5432/archon',
      validate: value => {
        if (!value) {
          return 'Connection string is required';
        }
        if (!value.startsWith('postgresql://') && !value.startsWith('postgres://')) {
          return 'Must be a valid PostgreSQL URL (postgresql:// or postgres://)';
        }
        return undefined;
      },
    });

    if (isCancel(url)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    return { type: 'postgresql', url };
  }

  return { type: 'sqlite' };
}

/**
 * Try to read Codex tokens from ~/.codex/auth.json
 */
function tryReadCodexAuth(): CodexTokens | null {
  const authPath = join(homedir(), '.codex', 'auth.json');

  if (!existsSync(authPath)) {
    return null;
  }

  try {
    const content = readFileSync(authPath, 'utf-8');
    const auth = JSON.parse(content) as {
      tokens?: {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
    };

    if (
      auth.tokens?.id_token &&
      auth.tokens?.access_token &&
      auth.tokens?.refresh_token &&
      auth.tokens?.account_id
    ) {
      return {
        idToken: auth.tokens.id_token,
        accessToken: auth.tokens.access_token,
        refreshToken: auth.tokens.refresh_token,
        accountId: auth.tokens.account_id,
      };
    }
  } catch {
    // Invalid JSON or other error
  }

  return null;
}

/**
 * Collect Claude authentication method
 */
/**
 * Resolve the Claude Code executable path for CLAUDE_BIN_PATH.
 * Auto-detects common install locations and falls back to prompting the user.
 * Returns undefined if the user declines to configure (setup continues; the
 * compiled binary will error with clear instructions on first Claude query).
 */
async function collectClaudeBinaryPath(): Promise<string | undefined> {
  const detected = detectClaudeExecutablePath();

  if (detected) {
    const useDetected = await confirm({
      message: `Found Claude Code at ${detected}. Write this to CLAUDE_BIN_PATH?`,
      initialValue: true,
    });
    if (isCancel(useDetected)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }
    if (useDetected) return detected;
  }

  const nativeExample =
    process.platform === 'win32' ? '%USERPROFILE%\\.local\\bin\\claude.exe' : '~/.local/bin/claude';

  note(
    'Compiled Archon binaries need CLAUDE_BIN_PATH set to the Claude Code executable.\n' +
      'In dev (`bun run`) this is ignored — the SDK resolves it via node_modules.\n\n' +
      'Recommended (Anthropic default — native installer):\n' +
      `  macOS/Linux: ${nativeExample}\n` +
      '  Windows:     %USERPROFILE%\\.local\\bin\\claude.exe\n\n' +
      'Alternative (npm global install):\n' +
      '  $(npm root -g)/@anthropic-ai/claude-code/cli.js',
    'Claude binary path'
  );

  const customPath = await text({
    message: 'Absolute path to the Claude Code executable (leave blank to skip):',
    placeholder: nativeExample,
  });

  if (isCancel(customPath)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const trimmed = (customPath ?? '').trim();
  if (!trimmed) return undefined;

  if (!existsSync(trimmed)) {
    log.warning(
      `Path does not exist: ${trimmed}. Saving anyway — the compiled binary will error on first use until this is correct.`
    );
  }
  return trimmed;
}

async function collectClaudeAuth(): Promise<{
  authType: 'global' | 'apiKey' | 'oauthToken';
  apiKey?: string;
  oauthToken?: string;
}> {
  const authType = await select({
    message: 'How do you want to authenticate with Claude?',
    options: [
      {
        value: 'global',
        label: 'Use global auth from `claude /login` (Recommended)',
        hint: 'Simplest - uses your existing Claude login',
      },
      {
        value: 'apiKey',
        label: 'Provide API key',
        hint: 'From console.anthropic.com',
      },
      {
        value: 'oauthToken',
        label: 'Provide OAuth token',
        hint: 'For advanced use cases',
      },
    ],
  });

  if (isCancel(authType)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  if (authType === 'apiKey') {
    const apiKey = await password({
      message: 'Enter your Claude API key:',
      validate: value => {
        if (!value || value.length < 10) {
          return 'Please enter a valid API key';
        }
        return undefined;
      },
    });

    if (isCancel(apiKey)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    return { authType: 'apiKey', apiKey };
  }

  if (authType === 'oauthToken') {
    const oauthToken = await password({
      message: 'Enter your Claude OAuth token:',
      validate: value => {
        if (!value || value.length < 10) {
          return 'Please enter a valid OAuth token';
        }
        return undefined;
      },
    });

    if (isCancel(oauthToken)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    return { authType: 'oauthToken', oauthToken };
  }

  return { authType: 'global' };
}

/**
 * Collect Codex authentication
 */
async function collectCodexAuth(): Promise<CodexTokens | null> {
  // Try to auto-import from ~/.codex/auth.json
  const existingAuth = tryReadCodexAuth();

  if (existingAuth) {
    const useExisting = await confirm({
      message: 'Found existing Codex auth at ~/.codex/auth.json. Use it?',
    });

    if (isCancel(useExisting)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    if (useExisting) {
      return existingAuth;
    }
  } else {
    note(
      'Codex requires authentication tokens.\n\n' +
        'To get them:\n' +
        '1. Run `codex login` in your terminal\n' +
        '2. Complete the login flow\n' +
        '3. Tokens will be saved to ~/.codex/auth.json\n\n' +
        'You can skip Codex setup now and run `archon setup` again later.',
      'Codex Auth'
    );
  }

  const enterManually = await confirm({
    message: 'Enter Codex tokens manually?',
  });

  if (isCancel(enterManually)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  if (!enterManually) {
    return null;
  }

  const idToken = await password({
    message: 'Enter CODEX_ID_TOKEN:',
    validate: value => {
      if (!value) return 'Token is required';
      return undefined;
    },
  });

  if (isCancel(idToken)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const accessToken = await password({
    message: 'Enter CODEX_ACCESS_TOKEN:',
    validate: value => {
      if (!value) return 'Token is required';
      return undefined;
    },
  });

  if (isCancel(accessToken)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const refreshToken = await password({
    message: 'Enter CODEX_REFRESH_TOKEN:',
    validate: value => {
      if (!value) return 'Token is required';
      return undefined;
    },
  });

  if (isCancel(refreshToken)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const accountId = await text({
    message: 'Enter CODEX_ACCOUNT_ID:',
    validate: value => {
      if (!value) return 'Account ID is required';
      return undefined;
    },
  });

  if (isCancel(accountId)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return {
    idToken,
    accessToken,
    refreshToken,
    accountId,
  };
}

/**
 * Collect AI assistant configuration
 */
async function collectAIConfig(): Promise<SetupConfig['ai']> {
  const assistants = await multiselect({
    message:
      'Which built-in AI assistant(s) will you use? (↑↓ navigate, space select, enter confirm)',
    options: [
      { value: 'claude', label: 'Claude (Recommended)', hint: 'Anthropic Claude Code SDK' },
      { value: 'codex', label: 'Codex', hint: 'OpenAI Codex SDK' },
    ],
    required: false,
  });

  if (isCancel(assistants)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  let hasClaude = assistants.includes('claude');
  let hasCodex = assistants.includes('codex');

  // Check if selected CLI tools are installed
  if (hasClaude && !isCommandAvailable('claude')) {
    note(CLI_INSTALL_INSTRUCTIONS.claude.instructions, 'Claude Code Not Found');
    const continueWithoutClaude = await confirm({
      message: 'Continue setup without Claude?',
      initialValue: false,
    });
    if (isCancel(continueWithoutClaude)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }
    if (!continueWithoutClaude) {
      cancel('Please install Claude Code and run setup again.');
      process.exit(0);
    }
    hasClaude = false;
  }

  if (hasCodex && !isCommandAvailable('codex')) {
    // On non-macOS platforms, npm is the only install method and requires Node.js 18+
    if (process.platform !== 'darwin') {
      const nodeVersion = getNodeVersion();
      if (!nodeVersion) {
        note(
          `Node.js is required to install Codex CLI via npm.

Install Node.js 18 or later from:
    https://nodejs.org/

Or use a version manager like nvm:
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
    nvm install 18

After installing Node.js, run 'archon setup' again.`,
          'Node.js Not Found'
        );
        const continueWithoutCodex = await confirm({
          message: 'Continue setup without Codex?',
          initialValue: false,
        });
        if (isCancel(continueWithoutCodex)) {
          cancel('Setup cancelled.');
          process.exit(0);
        }
        if (!continueWithoutCodex) {
          cancel('Please install Node.js 18+ and run setup again.');
          process.exit(0);
        }
        hasCodex = false;
      } else if (nodeVersion.major < 18) {
        note(
          `Node.js ${nodeVersion.major}.${nodeVersion.minor}.${nodeVersion.patch} is installed, but Codex CLI requires Node.js 18 or later.

Upgrade Node.js from:
    https://nodejs.org/

Or use a version manager like nvm:
    nvm install 18
    nvm use 18

After upgrading, run 'archon setup' again.`,
          'Node.js Version Too Old'
        );
        const continueWithoutCodex = await confirm({
          message: 'Continue setup without Codex?',
          initialValue: false,
        });
        if (isCancel(continueWithoutCodex)) {
          cancel('Setup cancelled.');
          process.exit(0);
        }
        if (!continueWithoutCodex) {
          cancel('Please upgrade Node.js to 18+ and run setup again.');
          process.exit(0);
        }
        hasCodex = false;
      }
    }

    // If we still want Codex (Node check passed or on macOS), show install instructions
    if (hasCodex) {
      note(CLI_INSTALL_INSTRUCTIONS.codex.instructions, 'Codex CLI Not Found');
      const continueWithoutCodex = await confirm({
        message: 'Continue setup without Codex?',
        initialValue: false,
      });
      if (isCancel(continueWithoutCodex)) {
        cancel('Setup cancelled.');
        process.exit(0);
      }
      if (!continueWithoutCodex) {
        cancel('Please install Codex CLI and run setup again.');
        process.exit(0);
      }
      hasCodex = false;
    }
  }

  if (!hasClaude && !hasCodex) {
    log.warning('No AI assistant selected. You can add one later by running `archon setup` again.');
    return {
      claude: false,
      codex: false,
      defaultAssistant: getRegisteredProviders().find(p => p.builtIn)?.id ?? 'claude',
    };
  }

  let claudeAuthType: 'global' | 'apiKey' | 'oauthToken' | undefined;
  let claudeApiKey: string | undefined;
  let claudeOauthToken: string | undefined;
  let claudeBinaryPath: string | undefined;
  let codexTokens: CodexTokens | undefined;

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

  // Determine default assistant — use the registry, but keep setup/auth flows built-in only.
  // Default to first registered built-in provider rather than hardcoding 'claude'.
  let defaultAssistant = getRegisteredProviders().find(p => p.builtIn)?.id ?? 'claude';

  if (hasClaude && hasCodex) {
    const providerChoices = getRegisteredProviders()
      .filter(p => p.builtIn)
      .map(p => ({
        value: p.id,
        label: p.id === 'claude' ? `${p.displayName} (Recommended)` : p.displayName,
      }));

    const defaultChoice = await select({
      message: 'Which should be the default AI assistant?',
      options: providerChoices,
    });

    if (isCancel(defaultChoice)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    defaultAssistant = defaultChoice;
  } else if (hasCodex && !hasClaude) {
    defaultAssistant = 'codex';
  }

  return {
    claude: hasClaude,
    claudeAuthType,
    claudeApiKey,
    claudeOauthToken,
    ...(claudeBinaryPath !== undefined ? { claudeBinaryPath } : {}),
    codex: hasCodex,
    codexTokens,
    defaultAssistant,
  };
}

/**
 * Collect platform selection
 */
async function collectPlatforms(): Promise<SetupConfig['platforms']> {
  const platforms = await multiselect({
    message: 'Which platforms do you want to connect? (↑↓ navigate, space select, enter confirm)',
    options: [
      { value: 'github', label: 'GitHub', hint: 'Respond to issues/PRs via webhooks' },
      { value: 'telegram', label: 'Telegram', hint: 'Chat bot via BotFather' },
      { value: 'slack', label: 'Slack', hint: 'Workspace app with Socket Mode' },
      { value: 'discord', label: 'Discord', hint: 'Server bot' },
    ],
    required: false,
  });

  if (isCancel(platforms)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return {
    github: platforms.includes('github'),
    telegram: platforms.includes('telegram'),
    slack: platforms.includes('slack'),
    discord: platforms.includes('discord'),
  };
}

/**
 * Collect GitHub credentials
 */
async function collectGitHubConfig(): Promise<GitHubConfig> {
  note(
    'GitHub Personal Access Token Setup\n\n' +
      '1. Go to github.com/settings/tokens\n' +
      '2. Click "Generate new token" -> "Fine-grained token"\n' +
      '3. Set expiration and select your target repository\n' +
      '4. Under Permissions, enable:\n' +
      '   - Issues: Read and write\n' +
      '   - Pull requests: Read and write\n' +
      '   - Contents: Read\n' +
      '5. Generate and copy the token',
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

  if (isCancel(token)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const allowedUsers = await text({
    message: 'Enter allowed GitHub usernames (comma-separated, or leave empty for all):',
    placeholder: 'username1,username2',
  });

  if (isCancel(allowedUsers)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const customMention = await confirm({
    message: 'Do you want to set a custom @mention name? (Default: archon)',
  });

  if (isCancel(customMention)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

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

    if (isCancel(mention)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    botMention = mention;
  }

  // Auto-generate webhook secret
  const webhookSecret = generateWebhookSecret();
  log.success('Generated webhook secret (save this for GitHub webhook config)');

  return {
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
    'Telegram Bot Setup\n\n' +
      'Step 1: Create your bot\n' +
      '1. Open Telegram and search for @BotFather\n' +
      '2. Send /newbot\n' +
      '3. Choose a display name (e.g., "My Archon Bot")\n' +
      '4. Choose a username (must end in "bot")\n' +
      '5. Copy the token BotFather gives you\n\n' +
      'Step 2: Get your user ID\n' +
      '1. Search for @userinfobot on Telegram\n' +
      '2. Send any message\n' +
      '3. It will reply with your user ID (a number)',
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

  if (isCancel(botToken)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const allowedUserIds = await text({
    message: 'Enter allowed Telegram user IDs (comma-separated, or leave empty for all):',
    placeholder: '123456789,987654321',
  });

  if (isCancel(allowedUserIds)) {
    cancel('Setup cancelled.');
    process.exit(0);
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

  if (isCancel(botToken)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const appToken = await password({
    message: 'Enter your Slack App Token (xapp-...):',
    validate: value => {
      if (!value?.startsWith('xapp-')) {
        return 'Please enter a valid app token (starts with xapp-)';
      }
      return undefined;
    },
  });

  if (isCancel(appToken)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const allowedUserIds = await text({
    message: 'Enter allowed Slack user IDs (comma-separated, or leave empty for all):',
    placeholder: 'U12345678,U87654321',
  });

  if (isCancel(allowedUserIds)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return {
    botToken,
    appToken,
    allowedUserIds: allowedUserIds || '',
  };
}

/**
 * Collect Discord credentials
 */
async function collectDiscordConfig(): Promise<DiscordConfig> {
  note(
    'Discord Bot Setup\n\n' +
      '1. Go to discord.com/developers/applications\n' +
      '2. Click "New Application" and name it\n' +
      '3. Go to "Bot" in sidebar:\n' +
      '   - Click "Reset Token" and copy it\n' +
      '   - Enable "MESSAGE CONTENT INTENT"\n' +
      '4. Go to "OAuth2" -> "URL Generator":\n' +
      '   - Select scope: bot\n' +
      '   - Select permissions: Send Messages, Read Message History\n' +
      '   - Open generated URL to add bot to your server\n\n' +
      'Get your user ID:\n' +
      '- Discord Settings -> Advanced -> Enable Developer Mode\n' +
      '- Right-click yourself -> Copy User ID',
    'Discord Setup'
  );

  const botToken = await password({
    message: 'Enter your Discord Bot Token:',
    validate: value => {
      if (!value || value.length < 50) {
        return 'Please enter a valid Discord bot token';
      }
      return undefined;
    },
  });

  if (isCancel(botToken)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const allowedUserIds = await text({
    message: 'Enter allowed Discord user IDs (comma-separated, or leave empty for all):',
    placeholder: '123456789012345678,987654321098765432',
  });

  if (isCancel(allowedUserIds)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return {
    botToken,
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

  if (isCancel(customName)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

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

  if (isCancel(name)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return name;
}

// =============================================================================
// File Generation and Writing
// =============================================================================

/**
 * Generate .env file content from collected configuration
 */
export function generateEnvContent(config: SetupConfig): string {
  const lines: string[] = [];

  // Header
  lines.push('# Archon Configuration');
  lines.push('# Generated by `archon setup`');
  lines.push('');

  // Database
  lines.push('# Database');
  if (config.database.type === 'postgresql' && config.database.url) {
    lines.push(`DATABASE_URL=${config.database.url}`);
  } else {
    lines.push('# Using SQLite (default) - no DATABASE_URL needed');
  }
  lines.push('');

  // AI Assistants
  lines.push('# AI Assistants');

  if (config.ai.claude) {
    if (config.ai.claudeAuthType === 'global') {
      lines.push('CLAUDE_USE_GLOBAL_AUTH=true');
    } else if (config.ai.claudeAuthType === 'apiKey' && config.ai.claudeApiKey) {
      lines.push('CLAUDE_USE_GLOBAL_AUTH=false');
      lines.push(`CLAUDE_API_KEY=${config.ai.claudeApiKey}`);
    } else if (config.ai.claudeAuthType === 'oauthToken' && config.ai.claudeOauthToken) {
      lines.push('CLAUDE_USE_GLOBAL_AUTH=false');
      lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${config.ai.claudeOauthToken}`);
    }
    if (config.ai.claudeBinaryPath) {
      lines.push(`CLAUDE_BIN_PATH=${config.ai.claudeBinaryPath}`);
    }
  } else {
    lines.push('# Claude not configured');
  }
  lines.push('');

  if (config.ai.codex && config.ai.codexTokens) {
    lines.push('# Codex Authentication');
    lines.push(`CODEX_ID_TOKEN=${config.ai.codexTokens.idToken}`);
    lines.push(`CODEX_ACCESS_TOKEN=${config.ai.codexTokens.accessToken}`);
    lines.push(`CODEX_REFRESH_TOKEN=${config.ai.codexTokens.refreshToken}`);
    lines.push(`CODEX_ACCOUNT_ID=${config.ai.codexTokens.accountId}`);
    lines.push('');
  }

  // Default AI Assistant
  lines.push('# Default AI Assistant');
  lines.push(`DEFAULT_AI_ASSISTANT=${config.ai.defaultAssistant}`);
  lines.push('');

  // GitHub
  if (config.platforms.github && config.github) {
    lines.push('# GitHub');
    lines.push(`GH_TOKEN=${config.github.token}`);
    lines.push(`GITHUB_TOKEN=${config.github.token}`);
    lines.push(`WEBHOOK_SECRET=${config.github.webhookSecret}`);
    if (config.github.allowedUsers) {
      lines.push(`GITHUB_ALLOWED_USERS=${config.github.allowedUsers}`);
    }
    if (config.github.botMention) {
      lines.push(`GITHUB_BOT_MENTION=${config.github.botMention}`);
    }
    lines.push('');
  }

  // Telegram
  if (config.platforms.telegram && config.telegram) {
    lines.push('# Telegram');
    lines.push(`TELEGRAM_BOT_TOKEN=${config.telegram.botToken}`);
    if (config.telegram.allowedUserIds) {
      lines.push(`TELEGRAM_ALLOWED_USER_IDS=${config.telegram.allowedUserIds}`);
    }
    lines.push('TELEGRAM_STREAMING_MODE=stream');
    lines.push('');
  }

  // Slack
  if (config.platforms.slack && config.slack) {
    lines.push('# Slack');
    lines.push(`SLACK_BOT_TOKEN=${config.slack.botToken}`);
    lines.push(`SLACK_APP_TOKEN=${config.slack.appToken}`);
    if (config.slack.allowedUserIds) {
      lines.push(`SLACK_ALLOWED_USER_IDS=${config.slack.allowedUserIds}`);
    }
    lines.push('SLACK_STREAMING_MODE=batch');
    lines.push('');
  }

  // Discord
  if (config.platforms.discord && config.discord) {
    lines.push('# Discord');
    lines.push(`DISCORD_BOT_TOKEN=${config.discord.botToken}`);
    if (config.discord.allowedUserIds) {
      lines.push(`DISCORD_ALLOWED_USER_IDS=${config.discord.allowedUserIds}`);
    }
    lines.push('DISCORD_STREAMING_MODE=batch');
    lines.push('');
  }

  // Bot Display Name
  if (config.botDisplayName !== 'Archon') {
    lines.push('# Bot Display Name');
    lines.push(`BOT_DISPLAY_NAME=${config.botDisplayName}`);
    lines.push('');
  }

  // Server
  // PORT is intentionally omitted: both the Hono server (packages/core/src/utils/port-allocation.ts)
  // and the Vite dev proxy (packages/web/vite.config.ts) default to 3090 when unset, which keeps
  // them in sync. Writing a fixed PORT here risked a mismatch if ~/.archon/.env leaks a PORT that
  // the Vite proxy (which only reads repo-local .env) never sees — see #1152.
  lines.push('# Server');
  lines.push('# PORT=3090  # Default: 3090. Uncomment to override.');
  lines.push('');

  // Concurrency
  lines.push('# Concurrency');
  lines.push('MAX_CONCURRENT_CONVERSATIONS=10');

  return lines.join('\n');
}

/**
 * Resolve the target path for the selected scope. Delegates to `@archon/paths`
 * so Docker (`/.archon`), the `ARCHON_HOME` override, and the "undefined"
 * literal guard behave identically to the loader. Never resolves to
 * `<repoPath>/.env` — that path belongs to the user.
 */
export function resolveScopedEnvPath(scope: 'home' | 'project', repoPath: string): string {
  if (scope === 'project') return pathsGetRepoArchonEnvPath(repoPath);
  return pathsGetArchonEnvPath();
}

/**
 * Serialize a key/value map back to `KEY=value` lines. Values with whitespace,
 * `#`, `"`, `'`, `\n`, or `\r` are double-quoted with `\\`, `"`, `\n`, `\r`
 * escaped so round-tripping through dotenv.parse is stable.
 */
export function serializeEnv(entries: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, rawValue] of Object.entries(entries)) {
    const value = rawValue;
    const needsQuoting = /[\s#"'\n\r]/.test(value) || value === '';
    if (needsQuoting) {
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
      lines.push(`${key}="${escaped}"`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/**
 * Produce a filesystem-safe ISO timestamp (no `:` or `.` characters).
 */
function backupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

interface WriteScopedEnvResult {
  targetPath: string;
  backupPath: string | null;
  /** Keys present in the existing file that were preserved against the proposed set. */
  preservedKeys: string[];
  /** True when `--force` overrode the merge. */
  forced: boolean;
}

/**
 * Write env content to exactly one archon-owned file, selected by scope.
 * Merge-only by default (existing non-empty values win, user-added keys
 * survive). Backs up the existing file (if any) before every rewrite, even
 * when `--force` is set.
 */
export function writeScopedEnv(
  content: string,
  options: { scope: 'home' | 'project'; repoPath: string; force: boolean }
): WriteScopedEnvResult {
  const targetPath = resolveScopedEnvPath(options.scope, options.repoPath);
  const parentDir = dirname(targetPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const exists = existsSync(targetPath);
  let backupPath: string | null = null;
  if (exists) {
    backupPath = `${targetPath}.archon-backup-${backupTimestamp()}`;
    copyFileSync(targetPath, backupPath);
    // Backups carry tokens/secrets — match the 0o600 we set on the live file.
    chmodSync(backupPath, 0o600);
  }

  const preservedKeys: string[] = [];
  let finalContent: string;

  if (options.force || !exists) {
    finalContent = content;
    if (options.force && backupPath) {
      process.stderr.write(
        `[archon] --force: overwriting ${targetPath} (backup at ${backupPath})\n`
      );
    }
  } else {
    // Merge: existing non-empty values win; proposed-only keys are added;
    // existing-only keys (user customizations) are preserved verbatim.
    const existingRaw = readFileSync(targetPath, 'utf-8');
    const existing = parseDotenv(existingRaw);
    const proposed = parseDotenv(content);
    const merged: Record<string, string> = { ...existing };
    for (const [key, value] of Object.entries(proposed)) {
      const prior = existing[key];
      // Treat whitespace-only existing values as empty — otherwise a
      // copy-paste stray `   ` would silently defeat the wizard's update for
      // that key forever.
      const priorIsEmpty = prior === undefined || prior.trim() === '';
      if (!(key in existing) || priorIsEmpty) {
        merged[key] = value;
      } else {
        preservedKeys.push(key);
      }
    }
    finalContent = serializeEnv(merged);
  }

  // 0o600 — env files hold secrets. Prevents group/world-readable writes on a
  // permissive umask. writeFileSync's default mode is 0o666 & ~umask.
  writeFileSync(targetPath, finalContent, { mode: 0o600 });
  // writeFileSync preserves mode for existing files; chmod guarantees 0o600
  // even when overwriting a file that pre-existed with looser permissions.
  chmodSync(targetPath, 0o600);
  return { targetPath, backupPath, preservedKeys, forced: options.force && exists };
}

/**
 * Copy the bundled Archon skill files to <targetPath>/.claude/skills/archon/
 *
 * Always overwrites existing files to ensure the latest skill version is installed.
 *
 * The `bundled-skill` module is dynamically imported here so that its 18 top-level
 * `import … with { type: 'text' }` statements only execute when this function is
 * actually called. Compiled binaries (`bun build --compile`) still statically
 * analyze the literal-string `import()` and embed the chunk; linked-source
 * installs (`bun link`) don't touch the source skill files unless the user runs
 * `archon setup`. Without this indirection, every `archon` invocation —
 * including `archon --help` — fails at module load when the source skill files
 * are missing from disk.
 */
export async function copyArchonSkill(targetPath: string): Promise<void> {
  const { BUNDLED_SKILL_FILES } = await import('../bundled-skill');
  const skillRoot = join(targetPath, '.claude', 'skills', 'archon');
  for (const [relativePath, content] of Object.entries(BUNDLED_SKILL_FILES)) {
    const dest = join(skillRoot, relativePath);
    const destDir = dirname(dest);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    writeFileSync(dest, content);
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
function spawnWindowsTerminal(repoPath: string): SpawnResult {
  // Try Windows Terminal first (modern Windows 10/11)
  if (
    trySpawn('wt.exe', ['-d', repoPath, 'cmd', '/k', 'archon setup'], {
      detached: true,
      stdio: 'ignore',
    })
  ) {
    return { success: true };
  }

  // Fallback to cmd.exe with start command (works on all Windows)
  if (
    trySpawn('cmd.exe', ['/c', 'start', '""', '/D', repoPath, 'cmd', '/k', 'archon setup'], {
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
function spawnMacTerminal(repoPath: string): SpawnResult {
  // Escape single quotes in path for AppleScript
  const escapedPath = repoPath.replace(/'/g, "'\"'\"'");
  const script = `tell application "Terminal" to do script "cd '${escapedPath}' && archon setup"`;

  if (trySpawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' })) {
    return { success: true };
  }

  return { success: false, error: 'Could not open Terminal. Please run `archon setup` manually.' };
}

/**
 * Spawn terminal on Linux
 * Tries: x-terminal-emulator -> gnome-terminal -> konsole -> xterm
 */
function spawnLinuxTerminal(repoPath: string): SpawnResult {
  const setupCmd = 'archon setup; exec bash';

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
export function spawnTerminalWithSetup(repoPath: string): SpawnResult {
  const platform = process.platform;

  if (platform === 'win32') {
    return spawnWindowsTerminal(repoPath);
  } else if (platform === 'darwin') {
    return spawnMacTerminal(repoPath);
  } else {
    return spawnLinuxTerminal(repoPath);
  }
}

// =============================================================================
// Main Setup Command
// =============================================================================

/**
 * Main setup command entry point
 */
export async function setupCommand(options: SetupOptions): Promise<void> {
  // Handle --spawn flag
  if (options.spawn) {
    console.log('Opening setup wizard in a new terminal window...');
    const result = spawnTerminalWithSetup(options.repoPath);

    if (result.success) {
      console.log('Setup wizard opened. Complete the setup in the new terminal window.');
    } else {
      console.log('');
      console.log('Next step: run the setup wizard in a separate terminal.');
      console.log('');
      console.log(`    cd ${options.repoPath} && archon setup`);
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
    if (existing.platforms.discord) configuredPlatforms.push('Discord');

    const summary = [
      `Database: ${existing.hasDatabase ? 'PostgreSQL' : 'SQLite'}`,
      `Claude: ${existing.hasClaude ? 'Configured' : 'Not configured'}`,
      `Codex: ${existing.hasCodex ? 'Configured' : 'Not configured'}`,
      `Platforms: ${configuredPlatforms.length > 0 ? configuredPlatforms.join(', ') : 'None'}`,
    ].join('\n');

    note(summary, 'Existing Configuration Found');

    const modeChoice = await select({
      message: 'What would you like to do?',
      options: [
        { value: 'add', label: 'Add platforms', hint: 'Keep existing config, add new platforms' },
        { value: 'update', label: 'Update config', hint: 'Modify existing settings' },
        { value: 'fresh', label: 'Start fresh', hint: 'Replace all configuration' },
      ],
    });

    if (isCancel(modeChoice)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    mode = modeChoice as SetupMode;
  }

  // Collect configuration based on mode
  const s = spinner();

  let config: SetupConfig;

  if (mode === 'add') {
    // For 'add' mode, we keep existing and only collect new platforms
    s.start('Loading existing configuration...');

    // Read existing config values - for simplicity, start with defaults and merge
    config = {
      database: { type: 'sqlite' },
      ai: {
        claude: existing?.hasClaude ?? false,
        codex: existing?.hasCodex ?? false,
        defaultAssistant: getRegisteredProviders().find(p => p.builtIn)?.id ?? 'claude',
      },
      platforms: {
        github: existing?.platforms.github ?? false,
        telegram: existing?.platforms.telegram ?? false,
        slack: existing?.platforms.slack ?? false,
        discord: existing?.platforms.discord ?? false,
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
      discord: config.platforms.discord || newPlatforms.discord,
    };

    // Collect credentials for new platforms only
    if (newPlatforms.github && !existing?.platforms.github) {
      config.github = await collectGitHubConfig();
    }
    if (newPlatforms.telegram && !existing?.platforms.telegram) {
      config.telegram = await collectTelegramConfig();
    }
    if (newPlatforms.slack && !existing?.platforms.slack) {
      config.slack = await collectSlackConfig();
    }
    if (newPlatforms.discord && !existing?.platforms.discord) {
      config.discord = await collectDiscordConfig();
    }
  } else {
    // Fresh or update mode - collect everything
    const database = await collectDatabaseConfig();
    const ai = await collectAIConfig();
    const platforms = await collectPlatforms();

    config = {
      database,
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
    if (platforms.discord) {
      config.discord = await collectDiscordConfig();
    }

    // Collect bot display name
    config.botDisplayName = await collectBotDisplayName();
  }

  // Generate and write configuration. Wrap in try/catch so any fs exception
  // (permission denied, read-only FS, backup copy failure, etc.) stops the
  // spinner cleanly and surfaces an actionable error instead of a raw stack
  // trace after the user has filled out the entire wizard.
  s.start('Writing configuration...');

  const envContent = generateEnvContent(config);
  let writeResult: ReturnType<typeof writeScopedEnv>;
  try {
    writeResult = writeScopedEnv(envContent, {
      scope,
      repoPath: options.repoPath,
      force,
    });
  } catch (error) {
    s.stop('Failed to write configuration');
    const err = error as NodeJS.ErrnoException;
    const code = err.code ? ` (${err.code})` : '';
    cancel(`Could not write ${targetEnvPath}${code}: ${err.message}`);
    process.exit(1);
  }

  s.stop('Configuration written');

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

  if (isCancel(shouldCopySkill)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  let skillInstalledPath: string | null = null;

  if (shouldCopySkill) {
    const skillTargetRaw = await text({
      message: 'Project path to install the skill:',
      defaultValue: options.repoPath,
      placeholder: options.repoPath,
    });

    if (isCancel(skillTargetRaw)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    const skillTarget = skillTargetRaw;
    s.start('Installing Archon skill...');
    try {
      await copyArchonSkill(skillTarget);
    } catch (err) {
      s.stop('Archon skill installation failed');
      cancel(`Could not install skill: ${(err as NodeJS.ErrnoException).message}`);
      process.exit(1);
    }
    s.stop('Archon skill installed');
    skillInstalledPath = join(skillTarget, '.claude', 'skills', 'archon');
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
        process.exit(1);
      }
    }
  }

  // Summary
  const configuredPlatforms: string[] = [];
  if (config.platforms.github) configuredPlatforms.push('GitHub');
  if (config.platforms.telegram) configuredPlatforms.push('Telegram');
  if (config.platforms.slack) configuredPlatforms.push('Slack');
  if (config.platforms.discord) configuredPlatforms.push('Discord');

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

  const summaryLines = [
    `Database: ${config.database.type === 'postgresql' ? 'PostgreSQL' : 'SQLite (default)'}`,
    `AI: ${aiConfigured.length > 0 ? aiConfigured.join(', ') : 'None configured'}`,
    `Default: ${config.ai.defaultAssistant}`,
    `Platforms: ${configuredPlatforms.length > 0 ? configuredPlatforms.join(', ') : 'None'}`,
    '',
    `File written (${scope} scope):`,
    `  ${writeResult.targetPath}`,
  ];

  if (config.platforms.github && config.github) {
    summaryLines.push('');
    summaryLines.push('GitHub Webhook Setup:');
    summaryLines.push(`  Secret: ${config.github.webhookSecret}`);
    summaryLines.push('  Add this secret to your GitHub webhook configuration');
  }

  if (skillInstalledPath) {
    summaryLines.push('');
    summaryLines.push('Archon skill installed:');
    summaryLines.push(`  ${skillInstalledPath}`);
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

  outro('Setup complete! Run `archon version` to verify.');
}
