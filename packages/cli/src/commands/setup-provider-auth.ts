/**
 * Provider credential prompts and probes for the setup wizard: Claude auth and
 * binary path, Codex tokens, and the Pi backend, key, and default model.
 */
import { select, password, confirm, note, text, isCancel, cancel, log } from '@clack/prompts';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { execFileAsync } from '@archon/git';
import { CODEX_SETUP_ENV } from '@archon/providers/codex/setup-env';
import { getArchonHome as pathsGetArchonHome } from '@archon/paths';
import { cancelSetup, exitSetup, type CodexTokens } from './setup-shared';

// Pi backends offered by the setup wizard.
export const PI_BACKENDS = [
  {
    id: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    hint: 'claude-haiku-4-5, claude-opus-4-7, etc.',
  },
  { id: 'openai', envVar: 'OPENAI_API_KEY', label: 'OpenAI', hint: 'gpt-4o, gpt-5.6-sol, etc.' },
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
export async function collectPiConfig(): Promise<{
  model: string;
  apiKey?: string;
  apiKeyEnvVar?: string;
}> {
  const backendChoice = await select({
    message: 'Which Pi backend will you use as the default?',
    options: PI_BACKENDS.map(b => ({ value: b.id, label: b.label, hint: b.hint })),
  });

  if (isCancel(backendChoice)) cancelSetup();

  const backend = PI_BACKENDS.find(b => b.id === backendChoice);
  if (!backend) {
    // Unreachable: select() can only return one of the option values, but
    // narrow defensively so we never index PI_DEFAULT_MODELS with undefined.
    cancel('Unknown Pi backend selected.');
    exitSetup(1);
  }
  const model = PI_DEFAULT_MODELS[backendChoice] ?? `${backendChoice}/default`;

  const apiKey = await password({
    message: `Enter ${backend.envVar} (press Enter to skip — you can set it later):`,
    // Empty input is allowed; users can configure the key later by hand.
    validate: () => undefined,
  });

  if (isCancel(apiKey)) cancelSetup();

  const key = apiKey.trim();

  return {
    model,
    ...(key.length > 0 ? { apiKey: key, apiKeyEnvVar: backend.envVar } : {}),
  };
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
export async function collectClaudeBinaryPath(): Promise<string | undefined> {
  const detected = detectClaudeExecutablePath();

  if (detected) {
    const probe = await probeClaudeBinarySpawns(detected);
    const suffix = probe.ok ? '(spawns OK)' : `(could not spawn: ${probe.reason})`;
    const useDetected = await confirm({
      message: `Found Claude Code at ${detected} ${suffix}. Write this to CLAUDE_BIN_PATH?`,
      initialValue: true,
    });
    if (isCancel(useDetected)) cancelSetup();
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

  if (isCancel(customPath)) cancelSetup();

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
export async function collectClaudeAuth(): Promise<{
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

  if (isCancel(authType)) cancelSetup();

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

    if (isCancel(apiKey)) cancelSetup();

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

    if (isCancel(oauthToken)) cancelSetup();

    return { authType: 'oauthToken', oauthToken };
  }

  return { authType: 'global' };
}

/**
 * Collect Codex authentication
 */
export async function collectCodexAuth(): Promise<CodexTokens | null> {
  // Try to auto-import from ~/.codex/auth.json
  const existingAuth = tryReadCodexAuth();

  if (existingAuth) {
    const useExisting = await confirm({
      message: 'Found existing Codex auth at ~/.codex/auth.json. Use it?',
    });

    if (isCancel(useExisting)) cancelSetup();

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

  if (isCancel(enterManually)) cancelSetup();

  if (!enterManually) {
    return null;
  }

  const idToken = await password({
    message: `Enter ${CODEX_SETUP_ENV.idToken.name}:`,
    validate: value => {
      if (!value) return 'Token is required';
      return undefined;
    },
  });

  if (isCancel(idToken)) cancelSetup();

  const accessToken = await password({
    message: `Enter ${CODEX_SETUP_ENV.accessToken.name}:`,
    validate: value => {
      if (!value) return 'Token is required';
      return undefined;
    },
  });

  if (isCancel(accessToken)) cancelSetup();

  const refreshToken = await password({
    message: `Enter ${CODEX_SETUP_ENV.refreshToken.name}:`,
    validate: value => {
      if (!value) return 'Token is required';
      return undefined;
    },
  });

  if (isCancel(refreshToken)) cancelSetup();

  const accountId = await text({
    message: `Enter ${CODEX_SETUP_ENV.accountId.name}:`,
    validate: value => {
      if (!value) return 'Account ID is required';
      return undefined;
    },
  });

  if (isCancel(accountId)) cancelSetup();

  return {
    idToken,
    accessToken,
    refreshToken,
    accountId,
  };
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
  // handled correctly.
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
