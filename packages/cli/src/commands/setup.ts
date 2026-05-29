/**
 * Setup command - Interactive CLI wizard for Archon credential configuration
 *
 * Guides users through configuring:
 * - AI assistants (Claude and/or Codex)
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
import { copyArchonSkill } from './skill';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { spawn, execSync, spawnSync, type ChildProcess } from 'child_process';
import { execFileAsync } from '@archon/git';
import { getRegisteredProviders } from '@archon/providers';
import {
  getArchonEnvPath as pathsGetArchonEnvPath,
  getRepoArchonEnvPath as pathsGetRepoArchonEnvPath,
  getArchonHome as pathsGetArchonHome,
  createLogger,
} from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.setup');
  return cachedLog;
}

// =============================================================================
// Types
// =============================================================================

// Pi backends offered by the setup wizard. Keep `envVar` names in sync with
// `PI_API_KEY_VARS` in doctor.ts — the doctor check uses them to detect
// configured Pi auth.
const PI_BACKENDS = [
  {
    id: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    hint: 'claude-haiku-4-5, claude-opus-4-7, etc.',
  },
  { id: 'openai', envVar: 'OPENAI_API_KEY', label: 'OpenAI', hint: 'gpt-4o, gpt-5.3, etc.' },
  {
    id: 'google',
    envVar: 'GEMINI_API_KEY',
    label: 'Google (Gemini)',
    hint: 'gemini-2.0-flash, etc.',
  },
  {
    id: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    hint: 'qwen/qwen3-coder, many others',
  },
  {
    id: 'groq',
    envVar: 'GROQ_API_KEY',
    label: 'Groq',
    hint: 'llama-3.3-70b-versatile, etc.',
  },
  { id: 'mistral', envVar: 'MISTRAL_API_KEY', label: 'Mistral', hint: 'mistral-large, etc.' },
  { id: 'xai', envVar: 'XAI_API_KEY', label: 'xAI (Grok)', hint: 'grok-3, etc.' },
  {
    id: 'cerebras',
    envVar: 'CEREBRAS_API_KEY',
    label: 'Cerebras',
    hint: 'llama3.1-70b, etc.',
  },
  {
    id: 'huggingface',
    envVar: 'HUGGINGFACE_API_KEY',
    label: 'Hugging Face',
    hint: 'inference API',
  },
] as const;

const PI_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'anthropic/claude-haiku-4-5',
  openai: 'openai/gpt-4o',
  google: 'google/gemini-2.0-flash',
  openrouter: 'openrouter/qwen/qwen3-coder',
  groq: 'groq/llama-3.3-70b-versatile',
  mistral: 'mistral/mistral-large-latest',
  xai: 'xai/grok-3',
  cerebras: 'cerebras/llama3.1-70b',
  huggingface: 'huggingface/Qwen/Qwen2.5-72B-Instruct',
};

interface SetupConfig {
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
    pi: boolean;
    /** e.g. 'anthropic/claude-haiku-4-5' — written to ~/.archon/config.yaml */
    piModel?: string;
    /** API key value for the chosen Pi backend */
    piApiKey?: string;
    /** Canonical env var name for the chosen Pi backend, e.g. 'ANTHROPIC_API_KEY' */
    piApiKeyEnvVar?: string;
    defaultAssistant: string;
  };
  platforms: {
    github: boolean;
    telegram: boolean;
    slack: boolean;
  };
  github?: GitHubConfig;
  telegram?: TelegramConfig;
  slack?: SlackConfig;
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

interface CodexTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

interface ExistingConfig {
  hasClaude: boolean;
  hasCodex: boolean;
  hasPi: boolean;
  platforms: {
    github: boolean;
    telegram: boolean;
    slack: boolean;
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
    hasClaude:
      hasEnvValue(content, 'CLAUDE_API_KEY') ||
      hasEnvValue(content, 'CLAUDE_CODE_OAUTH_TOKEN') ||
      hasEnvValue(content, 'CLAUDE_USE_GLOBAL_AUTH'),
    hasCodex:
      hasEnvValue(content, 'CODEX_ID_TOKEN') &&
      hasEnvValue(content, 'CODEX_ACCESS_TOKEN') &&
      hasEnvValue(content, 'CODEX_REFRESH_TOKEN') &&
      hasEnvValue(content, 'CODEX_ACCOUNT_ID'),
    // Detection is intentionally API-key-only (no DEFAULT_AI_ASSISTANT=pi check)
    // so that re-runs after partial configs still surface Pi. Doctor's checkPi
    // uses the stricter DEFAULT_AI_ASSISTANT=pi gate to avoid false passes for
    // Claude users who share the same key env vars.
    hasPi: PI_BACKENDS.some(b => hasEnvValue(content, b.envVar)),
    platforms: {
      github: hasEnvValue(content, 'GITHUB_TOKEN') || hasEnvValue(content, 'GH_TOKEN'),
      telegram: hasEnvValue(content, 'TELEGRAM_BOT_TOKEN'),
      slack: hasEnvValue(content, 'SLACK_BOT_TOKEN') && hasEnvValue(content, 'SLACK_APP_TOKEN'),
    },
  };
}

// =============================================================================
// Data Collection Functions
// =============================================================================

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
 * Collect Pi backend selection and optional API key.
 *
 * The wizard configures one Pi backend per run; users with multiple backends
 * can re-run setup or hand-edit `.env` and `~/.archon/config.yaml`.
 */
async function collectPiConfig(): Promise<{
  model: string;
  apiKey?: string;
  apiKeyEnvVar?: string;
}> {
  const backendChoice = await select({
    message: 'Which Pi backend will you use as the default?',
    options: PI_BACKENDS.map(b => ({ value: b.id, label: b.label, hint: b.hint })),
  });

  if (isCancel(backendChoice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const backend = PI_BACKENDS.find(b => b.id === backendChoice);
  if (!backend) {
    // Unreachable: select() can only return one of the option values, but
    // narrow defensively so we never index PI_DEFAULT_MODELS with undefined.
    cancel('Unknown Pi backend selected.');
    process.exit(1);
  }
  const model = PI_DEFAULT_MODELS[backendChoice] ?? `${backendChoice}/default`;

  const apiKey = await password({
    message: `Enter ${backend.envVar} (press Enter to skip — you can set it later):`,
    // Empty input is allowed; users can configure the key later by hand.
    validate: () => undefined,
  });

  if (isCancel(apiKey)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const key = apiKey.trim();

  return {
    model,
    ...(key.length > 0 ? { apiKey: key, apiKeyEnvVar: backend.envVar } : {}),
  };
}

/**
 * Verify the Pi npm module is loadable. Pi is bundled as a transitive dep of
 * `@archon/providers` so this should always pass, but catching broken compiled
 * builds at setup time is preferable to a silent runtime failure.
 *
 * The `loader` parameter is injected in tests so we don't need
 * `mock.module()` on `@archon/providers` (which would pollute other tests).
 */
export async function checkPiModule(
  loader: () => Promise<unknown> = () => import('@archon/providers')
): Promise<{ ok: boolean; error?: string }> {
  try {
    await loader();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getLog().warn({ err }, 'setup.pi_module_load_failed');
    return { ok: false, error: message };
  }
}

/**
 * Try to spawn the Claude binary with `--version` to confirm it actually runs.
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` with the spawn
 * error message so the caller can show it to the user. Bounded to 5s so a hung
 * process can't stall setup.
 */
async function probeClaudeBinarySpawns(
  path: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await execFileAsync(path, ['--version'], { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Resolve the Claude Code executable path for CLAUDE_BIN_PATH.
 * Auto-detects common install locations and falls back to prompting the user.
 * Returns undefined if the user declines to configure (setup continues; the
 * compiled binary will error with clear instructions on first Claude query).
 */
async function collectClaudeBinaryPath(): Promise<string | undefined> {
  const detected = detectClaudeExecutablePath();

  if (detected) {
    const probe = await probeClaudeBinarySpawns(detected);
    const suffix = probe.ok ? '(spawns OK)' : `(could not spawn: ${probe.reason})`;
    const useDetected = await confirm({
      message: `Found Claude Code at ${detected} ${suffix}. Write this to CLAUDE_BIN_PATH?`,
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
    return trimmed;
  }

  const probe = await probeClaudeBinarySpawns(trimmed);
  if (!probe.ok) {
    log.warning(
      `Could not spawn ${trimmed} --version: ${probe.reason}. Saving anyway — verify the binary works (try running it directly).`
    );
  }
  return trimmed;
}

/**
 * Collect Claude authentication method (API key, OAuth token, or global auth).
 */
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
    message: 'Which AI assistant(s) will you use? (↑↓ navigate, space select, enter confirm)',
    options: [
      { value: 'claude', label: 'Claude (Recommended)', hint: 'Anthropic Claude Code SDK' },
      { value: 'codex', label: 'Codex', hint: 'OpenAI Codex SDK' },
      {
        value: 'pi',
        label: 'Pi (community)',
        hint: '~20 LLM backends via provider/model refs',
      },
    ],
    required: false,
  });

  if (isCancel(assistants)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  let hasClaude = assistants.includes('claude');
  let hasCodex = assistants.includes('codex');
  let hasPi = assistants.includes('pi');

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

  if (!hasClaude && !hasCodex && !hasPi) {
    log.warning('No AI assistant selected. You can add one later by running `archon setup` again.');
    return {
      claude: false,
      codex: false,
      pi: false,
      defaultAssistant: getRegisteredProviders().find(p => p.builtIn)?.id ?? 'claude',
    };
  }

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

  // Collect Pi config if selected. Pi is bundled, so there's no PATH check —
  // instead we module-load test it to catch broken compiled builds.
  if (hasPi) {
    const piConfig = await collectPiConfig();
    piModel = piConfig.model;
    piApiKey = piConfig.apiKey;
    piApiKeyEnvVar = piConfig.apiKeyEnvVar;

    const piSpin = spinner();
    piSpin.start('Verifying Pi provider...');
    const piCheck = await checkPiModule();
    if (!piCheck.ok) {
      piSpin.stop('Pi provider check failed (non-fatal)');
      log.warning(`Pi: ${piCheck.error ?? 'module load failed'}`);
      const continueWithoutPi = await confirm({
        message: 'Continue setup without Pi?',
        initialValue: true,
      });
      if (isCancel(continueWithoutPi)) {
        cancel('Setup cancelled.');
        process.exit(0);
      }
      if (!continueWithoutPi) {
        cancel('Please check your Archon installation and run setup again.');
        process.exit(0);
      }
      hasPi = false;
      piModel = undefined;
      piApiKey = undefined;
      piApiKeyEnvVar = undefined;
    } else {
      piSpin.stop('Pi provider available');
    }
  }

  // Determine default assistant — use the registry, but keep setup/auth flows built-in only.
  // Default to first registered built-in provider rather than hardcoding 'claude'.
  let defaultAssistant = getRegisteredProviders().find(p => p.builtIn)?.id ?? 'claude';

  // `hasPi` may have been cleared above by a failed module check, so build the
  // selectedProviders list AFTER the Pi block.
  const selectedProviders = [
    ...(hasClaude ? ['claude'] : []),
    ...(hasCodex ? ['codex'] : []),
    ...(hasPi ? ['pi'] : []),
  ];

  if (selectedProviders.length > 1) {
    const providerChoices = selectedProviders.map(id => {
      const reg = getRegisteredProviders().find(p => p.id === id);
      const displayName = reg?.displayName ?? id;
      return {
        value: id,
        label: id === 'claude' ? `${displayName} (Recommended)` : displayName,
      };
    });

    const defaultChoice = await select({
      message: 'Which should be the default AI assistant?',
      options: providerChoices,
    });

    if (isCancel(defaultChoice)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    defaultAssistant = defaultChoice;
  } else if (selectedProviders.length === 1) {
    defaultAssistant = selectedProviders[0];
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

  if (isCancel(platforms)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

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

  if (isCancel(botToken)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  // Do NOT set required: true — clack's text() blocks the enter key when
  // required is true and the value is empty, which traps the user. Validate
  // post-hoc with a warning instead.
  const allowedUserIds = await text({
    message: 'Enter allowed Telegram user IDs (comma-separated):',
    placeholder: '123456789,987654321',
  });

  if (isCancel(allowedUserIds)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

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
  lines.push('# Using SQLite (default) - no DATABASE_URL needed');
  lines.push('# Set DATABASE_URL=postgresql://... to use PostgreSQL instead.');
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

  if (config.ai.pi && config.ai.piApiKey && config.ai.piApiKeyEnvVar) {
    lines.push('# Pi Authentication');
    lines.push(`${config.ai.piApiKeyEnvVar}=${config.ai.piApiKey}`);
    lines.push('');
  } else if (config.ai.pi) {
    lines.push('# Pi configured — set the backend API key manually');
    lines.push('# e.g. ANTHROPIC_API_KEY=sk-ant-...');
    lines.push('');
  } else {
    lines.push('# Pi not configured');
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

/**
 * Write the Pi model ref to `~/.archon/config.yaml` so Pi knows which backend
 * to use by default. Three branches:
 *   1. File already contains `pi:` — skip (idempotent; avoids duplicate blocks
 *      on re-runs or when the user has already configured this manually).
 *   2. File contains `assistants:` but no `pi:` — show a manual `note()`
 *      because we can't safely splice into existing YAML indentation.
 *   3. Otherwise — append a fresh `assistants: pi: model:` block.
 */
export function writeHomePiModelConfig(model: string): void {
  // Use the paths-package version of getArchonHome so Docker (/.archon) is
  // handled correctly — the local getArchonHome() always returns ~/.archon.
  const home = pathsGetArchonHome();
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'config.yaml');
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';

  // Use a regex to avoid false positives from substrings like `api:`.
  if (/^\s*pi\s*:/m.test(existing)) {
    log.info(
      `Pi model already present in ${configPath} — edit assistants.pi.model manually to change.`
    );
    return;
  }

  const escaped = model.replace(/"/g, '\\"');

  if (existing.includes('assistants:')) {
    // Don't risk splicing into the user's existing assistants: block — show
    // them the YAML to paste in by hand instead of corrupting indentation.
    note(
      `Add to ${configPath} under assistants:\n\n  pi:\n    model: "${escaped}"`,
      'Pi model config'
    );
    return;
  }

  writeFileSync(configPath, existing + `\nassistants:\n  pi:\n    model: "${escaped}"\n`);
  log.info(`Pi model written to ${configPath}`);
}

/**
 * Serialize a key/value map back to `KEY=value` lines. Values with whitespace,
 * `#`, `"`, `'`, `\n`, or `\r` are double-quoted with `\\`, `"`, `\n`, `\r`
 * escaped so round-tripping through dotenv.parse is stable.
 */
export function serializeEnv(entries: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
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
      ai: {
        claude: existing?.hasClaude ?? false,
        codex: existing?.hasCodex ?? false,
        pi: existing?.hasPi ?? false,
        defaultAssistant: getRegisteredProviders().find(p => p.builtIn)?.id ?? 'claude',
      },
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
  } else {
    const ai = await collectAIConfig();
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
  let projectConfigCreatedPath: string | null = null;

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

    s.start('Installing Archon skill...');
    try {
      await copyArchonSkill(skillTargetRaw);
    } catch (err) {
      s.stop('Archon skill installation failed');
      cancel(`Could not install skill: ${(err as NodeJS.ErrnoException).message}`);
      process.exit(1);
    }
    s.stop('Archon skill installed');
    skillInstalledPath = join(skillTargetRaw, '.claude', 'skills', 'archon');

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
        process.exit(1);
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
    `Default: ${config.ai.defaultAssistant}`,
    `Platforms: ${configuredPlatforms.length > 0 ? configuredPlatforms.join(', ') : 'None (CLI + skill only)'}`,
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
    await doctorCommand();
  }

  outro('Setup complete!');
}
