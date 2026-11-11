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
import { loadGlobalConfig } from '@archon/core/config/config-loader';
import { PI_PROVIDER_ENV_VARS } from '@archon/providers';
import { CODEX_SETUP_ENV } from '@archon/providers/codex/setup-env';
import { parsePiModelRef } from '@archon/providers/pi/model-ref';
import { getArchonHome as pathsGetArchonHome } from '@archon/paths';
import { type Document, isMap, parseDocument, type YAMLMap } from 'yaml';
import { cancelSetup, exitSetup, type CodexTokens } from './setup-shared';

// Pi backends offered by the setup wizard. Each backend's key variable comes from
// Pi's own map (`piBackendEnvVar`), so setup writes the variable Pi actually reads.
export const PI_BACKENDS = [
  { id: 'anthropic', label: 'Anthropic', hint: 'claude-haiku-4-5, claude-opus-4-7, etc.' },
  { id: 'openai', label: 'OpenAI', hint: 'gpt-4o, gpt-5.6-sol, etc.' },
  { id: 'google', label: 'Google (Gemini)', hint: 'gemini-2.5-flash, etc.' },
  { id: 'openrouter', label: 'OpenRouter', hint: 'qwen/qwen3-coder, many others' },
  { id: 'groq', label: 'Groq', hint: 'llama-3.3-70b-versatile, etc.' },
  { id: 'mistral', label: 'Mistral', hint: 'mistral-large, etc.' },
  { id: 'xai', label: 'xAI (Grok)', hint: 'grok-4.7, etc.' },
  { id: 'cerebras', label: 'Cerebras', hint: 'gpt-oss-120b, etc.' },
  { id: 'huggingface', label: 'Hugging Face', hint: 'inference API' },
] as const;

/** The env var Pi reads for a backend's key, from Pi's generated vendor map. */
export function piBackendEnvVar(backendId: string): string {
  const envVar = PI_PROVIDER_ENV_VARS[backendId];
  if (!envVar) throw new Error(`Pi has no API key variable for backend '${backendId}'`);
  return envVar;
}

/** Model setup saves for each backend; each one must be in Pi's built-in catalog. */
export const PI_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'anthropic/claude-haiku-4-5',
  openai: 'openai/gpt-4o',
  google: 'google/gemini-2.5-flash',
  openrouter: 'openrouter/qwen/qwen3-coder',
  groq: 'groq/llama-3.3-70b-versatile',
  mistral: 'mistral/mistral-large-latest',
  xai: 'xai/grok-4.7',
  cerebras: 'cerebras/gpt-oss-120b',
  huggingface: 'huggingface/MiniMaxAI/MiniMax-M2.5',
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
 * Collect the Pi model setup saves and how Pi authenticates to its backend.
 *
 * The model is settled first: when `~/.archon/config.yaml` already sets a
 * different Pi model, the user keeps it or switches to the chosen backend's
 * default. The credential question then names the backend of the model runs
 * will use, so a kept model for another backend is not checked against the
 * wrong key. Cancelling here stops setup before anything is written.
 *
 * Pi reads its own `auth.json` (written by `pi /login`), so a user who has
 * already logged in needs no key in Archon's `.env`. The key prompt is only
 * shown when the user says they want to provide one.
 *
 * The wizard configures one Pi backend per run; users with multiple backends
 * can re-run setup or hand-edit `.env` and `~/.archon/config.yaml`.
 */
export async function collectPiConfig(): Promise<{
  model: string;
  /**
   * The key variable for the model's backend, set for both choices so setup can check it
   * for conflicts. Absent when Pi has no key variable for that backend.
   */
  apiKeyEnvVar?: string;
  /** True when the user chose Pi's own login. */
  piLogin: boolean;
  apiKey?: string;
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
  const model = await resolvePiModel(
    PI_DEFAULT_MODELS[backendChoice] ?? `${backendChoice}/default`,
    backend.label
  );
  const provider = parsePiModelRef(model)?.provider;
  const envVar = provider ? PI_PROVIDER_ENV_VARS[provider] : undefined;
  if (!provider || !envVar) {
    log.info(
      `Pi has no API key variable for ${provider ?? model}, so setup does not ask for a key. Pi uses its own credentials for it.`
    );
    return { model, piLogin: false };
  }
  const label = PI_BACKENDS.find(b => b.id === provider)?.label ?? provider;

  const authType = await select({
    message: `How do you want Pi to authenticate with ${label}?`,
    options: [
      {
        value: 'piLogin',
        label: "Use Pi's own login from `pi /login`",
        hint:
          provider === 'anthropic'
            ? 'API key in auth.json only. A Claude Pro/Max login through Pi is not supported; use `provider: claude` for that'
            : 'Uses the credential Pi already keeps in its auth.json',
      },
      { value: 'apiKey', label: `Provide ${envVar}` },
    ],
  });

  if (isCancel(authType)) cancelSetup();
  if (authType === 'piLogin') return { model, apiKeyEnvVar: envVar, piLogin: true };

  const apiKey = await password({
    message: `Enter ${envVar} (press Enter to skip — you can set it later):`,
    // Empty input is allowed; users can configure the key later by hand.
    validate: () => undefined,
  });

  if (isCancel(apiKey)) cancelSetup();

  // clack's password prompt resolves `undefined`, not '', when Enter is
  // pressed on an empty field.
  const key = (apiKey ?? '').trim();

  return {
    model,
    apiKeyEnvVar: envVar,
    piLogin: false,
    ...(key.length > 0 ? { apiKey: key } : {}),
  };
}

/**
 * The Pi model setup will save: `chosen`, or the different model already in
 * `~/.archon/config.yaml` when the user keeps it. Read through the config loader
 * runs use, so the saved value is the one a run would see.
 */
async function resolvePiModel(chosen: string, chosenLabel: string): Promise<string> {
  const configPath = join(pathsGetArchonHome(), 'config.yaml');
  let saved: string | undefined;
  try {
    const model = (await loadGlobalConfig(true, { readOnly: true })).assistants?.pi?.model;
    saved = typeof model === 'string' ? model.trim() : undefined;
  } catch (error) {
    // Runs cannot load this file either; the model write reports it again if it cannot parse it.
    log.warning(
      `Could not read ${configPath} (${(error as Error).message}), so setup could not check its saved Pi model.`
    );
    return chosen;
  }
  if (!saved || saved === chosen) return chosen;

  const savedProvider = parsePiModelRef(saved)?.provider;
  const sameBackend = savedProvider === parsePiModelRef(chosen)?.provider;
  const choice = await select({
    message: `${configPath} already sets the Pi model to ${saved}. Which one should Archon use?`,
    options: [
      {
        value: 'keep',
        label: `Keep ${saved}`,
        ...(sameBackend
          ? {}
          : { hint: `Pi then authenticates with ${savedProvider ?? saved}, not ${chosenLabel}` }),
      },
      { value: 'switch', label: `Switch to ${chosen}` },
    ],
    // A saved model for the same backend is likely a deliberate pick; one for another
    // backend would leave the backend just chosen unused.
    initialValue: sameBackend ? 'keep' : 'switch',
  });
  if (isCancel(choice)) cancelSetup();
  return choice === 'keep' ? saved : chosen;
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
 * Set `assistants.pi.model` in `~/.archon/config.yaml`, keeping every other
 * setting and comment. The model was already agreed in `collectPiConfig`, which
 * asks before replacing a different saved model, so this writes without asking.
 * A file setup cannot parse, or an `assistants` value that is not a mapping,
 * is left alone with a note showing the YAML to add.
 */
export async function writeHomePiModelConfig(model: string): Promise<void> {
  // Use the paths-package version of getArchonHome so Docker (/.archon) is
  // handled correctly.
  const home = pathsGetArchonHome();
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'config.yaml');
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const doc = parseDocument(existing);
  const manualNote = (): void =>
    note(`Add to ${configPath}:\n\nassistants:\n  pi:\n    model: "${model}"`, 'Pi model config');

  if (doc.errors.length > 0) {
    log.warning(`Could not parse ${configPath}; the Pi model was not written.`);
    manualNote();
    return;
  }
  const current = doc.getIn(['assistants', 'pi', 'model']);
  if (current === model) {
    log.info(`Pi model already set to ${model} in ${configPath}`);
    return;
  }
  if (!setPiModel(doc, model)) {
    manualNote();
    return;
  }
  writeFileSync(configPath, doc.toString());
  log.info(`Pi model written to ${configPath}`);
}

/** Create any missing level of `assistants.pi` and set its model. False when a level is not a mapping. */
function setPiModel(doc: Document, model: string): boolean {
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) return false;
  const childMap = (map: YAMLMap, key: string): YAMLMap | undefined => {
    if (map.get(key) == null) map.set(key, doc.createNode({}));
    const child = map.get(key);
    return isMap(child) ? child : undefined;
  };
  const assistants = childMap(doc.contents, 'assistants');
  const pi = assistants && childMap(assistants, 'pi');
  if (!pi) return false;
  pi.set('model', model);
  return true;
}
