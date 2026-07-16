/**
 * Doctor command - Verifies the local Archon setup.
 *
 * Also invoked from the end of `archon setup`; the setup wizard discards the
 * return value so a doctor failure does not abort setup (the env file was
 * already written successfully).
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileAsync } from '@archon/git';
import { BUNDLED_IS_BINARY, getArchonHome, createLogger, getTelemetryStatus } from '@archon/paths';
import {
  resolveCodexBinaryWithSource,
  type CodexBinarySource,
} from '@archon/providers/codex/binary-resolver';
import type { Codebase } from '@archon/core';

// Vendor-canonical credential id for Codex (since #1955 credentials are keyed
// by vendor, not agent). A connected `openai` key signals Codex intent even
// when it isn't the configured default assistant.
const CODEX_CREDENTIAL_VENDOR = 'openai';

// Env vars that indicate a Pi backend API key is configured. Keep in sync with
// `PI_BACKENDS` in setup.ts — these are the auth signals checkPi inspects.
const PI_API_KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'CEREBRAS_API_KEY',
  'HUGGINGFACE_API_KEY',
] as const;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.doctor');
  return cachedLog;
}

export interface CheckResult {
  label: string;
  status: 'pass' | 'fail' | 'skip';
  message: string;
}

export async function checkClaudeBinary(
  env: NodeJS.ProcessEnv,
  // Injected so tests can drive the binary-mode branch — `BUNDLED_IS_BINARY`
  // is a static const re-export and cannot be spied at runtime.
  isBinary: boolean = BUNDLED_IS_BINARY
): Promise<CheckResult> {
  const label = 'Claude binary';
  if (!isBinary) {
    return { label, status: 'skip', message: 'dev mode (SDK resolves via node_modules)' };
  }
  const path = env.CLAUDE_BIN_PATH;
  if (!path) {
    return {
      label,
      status: 'fail',
      message: 'CLAUDE_BIN_PATH is not set. Run `archon setup` to configure.',
    };
  }
  try {
    await execFileAsync(path, ['--version'], { timeout: 5000 });
    return { label, status: 'pass', message: `${path} (spawns OK)` };
  } catch (err) {
    return {
      label,
      status: 'fail',
      message: `${path} did not spawn: ${(err as Error).message}`,
    };
  }
}

export interface CodexBinaryDeps {
  /** `assistants.codex.codexBinaryPath` from the merged config, if configured. */
  configBinaryPath?: string;
  /** True when the merged default assistant resolves to codex. */
  isDefaultAssistant: boolean;
  /** True when the CLI user has connected an OpenAI (Codex) credential. */
  credentialConnected: boolean;
}

/**
 * Verify the Codex CLI binary resolves and spawns. Mirrors `checkClaudeBinary`,
 * but uses Codex's richer four-tier resolution (env → config → vendor →
 * autodetect) and reports which tier resolved it. Skips (never fails) when
 * Codex isn't the configured assistant anywhere and no OpenAI (Codex)
 * credential is connected, so Claude-only users aren't nagged about a binary
 * they will never use.
 */
export async function checkCodexBinary(
  env: NodeJS.ProcessEnv,
  // Injected so tests can drive every branch without the dynamic @archon/core
  // import or a real binary on disk.
  loadDeps: (env: NodeJS.ProcessEnv) => Promise<CodexBinaryDeps> = defaultLoadCodexBinaryDeps,
  resolve: (
    configPath?: string
  ) => Promise<
    { path: string; source: CodexBinarySource } | undefined
  > = resolveCodexBinaryWithSource
): Promise<CheckResult> {
  const label = 'Codex binary';

  let deps: CodexBinaryDeps;
  try {
    deps = await loadDeps(env);
  } catch (err) {
    // Config load can throw (e.g. a typo'd DEFAULT_AI_ASSISTANT) — degrade to
    // env-only signals rather than failing the whole check.
    getLog().debug({ err }, 'doctor.codex_deps_load_failed');
    deps = { isDefaultAssistant: false, credentialConnected: false };
  }

  const configured =
    env.DEFAULT_AI_ASSISTANT === 'codex' ||
    Boolean(env.CODEX_BIN_PATH) ||
    deps.isDefaultAssistant ||
    Boolean(deps.configBinaryPath) ||
    deps.credentialConnected;

  if (!configured) {
    return {
      label,
      status: 'skip',
      message: 'Codex not configured (not the default assistant, no OpenAI credential connected)',
    };
  }

  let resolved: { path: string; source: CodexBinarySource } | undefined;
  try {
    resolved = await resolve(deps.configBinaryPath);
  } catch (err) {
    // Binary mode + unresolved → the resolver throws with install instructions.
    return { label, status: 'fail', message: (err as Error).message };
  }

  // Dev mode: the resolver returns undefined and the SDK resolves via node_modules.
  if (!resolved) {
    return { label, status: 'skip', message: 'dev mode (SDK resolves via node_modules)' };
  }

  try {
    await execFileAsync(resolved.path, ['--version'], { timeout: 5000 });
    return {
      label,
      status: 'pass',
      message: `${resolved.path} (via ${resolved.source}, spawns OK)`,
    };
  } catch (err) {
    return {
      label,
      status: 'fail',
      message: `${resolved.path} did not spawn: ${(err as Error).message}`,
    };
  }
}

async function defaultLoadCodexBinaryDeps(env: NodeJS.ProcessEnv): Promise<CodexBinaryDeps> {
  // Lazy imports so doctor doesn't pull the full @archon/core graph for an
  // unrelated check (matches defaultLoadDatabaseDeps / defaultLoadProviderDeps).
  const { loadConfig, listUserProviderKeys } = await import('@archon/core');
  const userDb = await import('@archon/core/db/users');
  const config = await loadConfig(process.cwd());

  let credentialConnected = false;
  const cliId = env.ARCHON_USER_ID || env.USER || env.USERNAME;
  if (cliId) {
    try {
      const user = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
      const rows = await listUserProviderKeys(user.id);
      credentialConnected = rows.some(r => r.provider === CODEX_CREDENTIAL_VENDOR);
    } catch (err) {
      // Credential lookup is best-effort — a DB hiccup shouldn't force the
      // binary check to run or skip; treat as "no credential connected".
      getLog().debug({ err }, 'doctor.codex_credential_lookup_failed');
    }
  }

  return {
    configBinaryPath: config.assistants.codex.codexBinaryPath,
    isDefaultAssistant: config.assistant === 'codex',
    credentialConnected,
  };
}

export interface OpenCodeDeps {
  /** True when the merged default assistant is opencode. */
  isDefaultAssistant: boolean;
  /** Cheap module-presence probe — resolves the SDK WITHOUT booting the server. */
  probeRuntimeModule: () => Promise<boolean>;
}

/**
 * Report whether the embedded OpenCode runtime SDK is present. OpenCode's
 * runtime is heavyweight to start (spawns a child process and binds a port),
 * so doctor NEVER boots it — it only probes that the SDK module resolves. Skips
 * unless OpenCode is the configured assistant or `--full` is passed, matching
 * the lazy-start posture of `GET /api/providers/opencode/credentials`.
 */
export async function checkOpenCode(
  env: NodeJS.ProcessEnv,
  full: boolean,
  loadDeps: () => Promise<OpenCodeDeps> = defaultLoadOpenCodeDeps
): Promise<CheckResult> {
  const label = 'OpenCode runtime';

  let deps: OpenCodeDeps;
  try {
    deps = await loadDeps();
  } catch (err) {
    getLog().debug({ err }, 'doctor.opencode_deps_load_failed');
    deps = { isDefaultAssistant: false, probeRuntimeModule: async (): Promise<boolean> => false };
  }

  const configured = env.DEFAULT_AI_ASSISTANT === 'opencode' || deps.isDefaultAssistant;
  if (!configured && !full) {
    return {
      label,
      status: 'skip',
      message: 'OpenCode not configured (pass --full to probe the runtime SDK)',
    };
  }

  let present: boolean;
  try {
    // Cheap probe only — resolves the SDK module without starting the server.
    present = await deps.probeRuntimeModule();
  } catch (err) {
    return {
      label,
      status: 'fail',
      message: `runtime SDK not resolvable: ${(err as Error).message}. Reinstall dependencies (bun install).`,
    };
  }

  if (present) {
    return {
      label,
      status: 'pass',
      message: 'embedded runtime SDK present (module resolves; server not started)',
    };
  }
  return {
    label,
    status: 'fail',
    message:
      '@opencode-ai/sdk resolved but the createOpencode entrypoint is missing — reinstall dependencies (bun install).',
  };
}

async function defaultLoadOpenCodeDeps(): Promise<OpenCodeDeps> {
  const { loadConfig } = await import('@archon/core');
  const { probeOpencodeRuntimeModule } =
    await import('@archon/providers/community/opencode/runtime');
  const config = await loadConfig(process.cwd());
  return {
    isDefaultAssistant: config.assistant === 'opencode',
    probeRuntimeModule: probeOpencodeRuntimeModule,
  };
}

export async function checkGhAuth(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'gh CLI';
  // Skip for users without GitHub configured — gh auth is irrelevant
  // to a CLI-only or Slack/Telegram setup, so reporting fail would be noise.
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) {
    return { label, status: 'skip', message: 'GitHub not configured (no GITHUB_TOKEN)' };
  }
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    return { label, status: 'pass', message: 'authenticated' };
  } catch (err) {
    return {
      label,
      status: 'fail',
      message: `gh auth status failed: ${(err as Error).message}. Run \`gh auth login\`.`,
    };
  }
}

/**
 * Thin wrapper around `existsSync` so tests can spy on it by name without
 * fighting ESM named-import rebinding limitations.  Matches the `probeFileExists`
 * pattern in `setup.ts`.
 */
export function probeAuthJsonExists(path: string): boolean {
  return existsSync(path);
}

export async function checkPi(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'Pi provider';
  const isDefault = env.DEFAULT_AI_ASSISTANT === 'pi';

  // Skip when Pi isn't the default — shared keys like ANTHROPIC_API_KEY shouldn't
  // trigger a pass for Claude-only users who happen to have them set.
  if (!isDefault) {
    return { label, status: 'skip', message: 'Pi not configured' };
  }

  // Pi reads OAuth credentials from ~/.pi/agent/auth.json (written by `pi /login`)
  // or API key env vars; either path is sufficient.
  const authJsonPath = join(homedir(), '.pi', 'agent', 'auth.json');
  if (probeAuthJsonExists(authJsonPath)) {
    return { label, status: 'pass', message: '~/.pi/agent/auth.json found' };
  }

  const foundKey = PI_API_KEY_VARS.find(v => (env[v] ?? '').trim().length > 0);
  if (foundKey) {
    return { label, status: 'pass', message: `${foundKey} is set` };
  }

  return {
    label,
    status: 'fail',
    message:
      'Pi is configured as default but no auth found. Run `pi /login` or set an API key env var (e.g. ANTHROPIC_API_KEY).',
  };
}

export interface DatabaseDeps {
  pool: { query: (sql: string) => Promise<unknown> };
  getDatabaseType: () => string;
}

export async function checkDatabase(
  // Injected so tests can drive both code paths without mocking the dynamic
  // import. Falls back to the lazy `@archon/core` import in production.
  loadDeps: () => Promise<DatabaseDeps> = defaultLoadDatabaseDeps
): Promise<CheckResult> {
  const label = 'Database';
  let deps: DatabaseDeps;
  try {
    deps = await loadDeps();
  } catch (err) {
    // Distinguish module-load failure from query failure — surfacing
    // "not reachable" for an import error misleads the user into running
    // `archon setup` when the real fix is a binary rebuild.
    getLog().error({ err }, 'doctor.db_module_load_failed');
    return {
      label,
      status: 'fail',
      message: `failed to load database module: ${(err as Error).message}`,
    };
  }
  try {
    const dbType = deps.getDatabaseType();
    await deps.pool.query('SELECT 1');
    return { label, status: 'pass', message: `reachable (${dbType})` };
  } catch (err) {
    getLog().error({ err }, 'doctor.db_query_failed');
    return { label, status: 'fail', message: `not reachable: ${(err as Error).message}` };
  }
}

async function defaultLoadDatabaseDeps(): Promise<DatabaseDeps> {
  // Lazy import so doctor doesn't pull in the full @archon/core graph just to
  // print --help or run a different check.
  const { pool, getDatabaseType } = await import('@archon/core');
  return { pool, getDatabaseType };
}

type FolderCodebase = Pick<Codebase, 'name' | 'default_cwd' | 'kind'>;

export interface FolderProjectDeps {
  findCodebaseByDefaultCwd: (cwd: string) => Promise<FolderCodebase | null>;
  findCodebaseByPathPrefix: (cwd: string) => Promise<FolderCodebase | null>;
  listChildRepos: (rootPath: string) => Promise<string[]>;
}

async function defaultLoadFolderProjectDeps(): Promise<FolderProjectDeps> {
  const codebaseDb = await import('@archon/core/db/codebases');
  const { listChildRepos } = await import('@archon/git');
  return {
    findCodebaseByDefaultCwd: codebaseDb.findCodebaseByDefaultCwd,
    findCodebaseByPathPrefix: codebaseDb.findCodebaseByPathPrefix,
    listChildRepos,
  };
}

/**
 * When the current directory is a registered folder project, report it and list
 * the git repos contained under its root. Skips quietly (not a failure) for a
 * normal git-repo cwd, an unregistered directory, or when the DB is unavailable.
 */
export async function checkFolderProject(
  cwd: string = process.cwd(),
  loadDeps: () => Promise<FolderProjectDeps> = defaultLoadFolderProjectDeps
): Promise<CheckResult> {
  const label = 'Folder project';
  let deps: FolderProjectDeps;
  try {
    deps = await loadDeps();
  } catch (err) {
    getLog().debug({ err }, 'doctor.folder_project_module_load_failed');
    return { label, status: 'skip', message: 'unavailable (module load failed)' };
  }
  let codebase: FolderCodebase | null;
  try {
    codebase =
      (await deps.findCodebaseByDefaultCwd(cwd)) ?? (await deps.findCodebaseByPathPrefix(cwd));
  } catch (err) {
    getLog().debug({ err, cwd }, 'doctor.folder_project_lookup_failed');
    return { label, status: 'skip', message: 'could not check (database unavailable)' };
  }
  if (codebase?.kind !== 'folder') {
    return { label, status: 'skip', message: 'cwd is not a registered folder project' };
  }
  const childRepos = await deps.listChildRepos(codebase.default_cwd);
  const shown = childRepos.slice(0, 10);
  const remaining = childRepos.length - shown.length;
  let reposMsg: string;
  if (childRepos.length === 0) {
    reposMsg = 'no contained git repos';
  } else {
    const moreSuffix = remaining > 0 ? `, … (+${String(remaining)} more)` : '';
    reposMsg = `${String(childRepos.length)} contained repo(s): ${shown.join(', ')}${moreSuffix}`;
  }
  return {
    label,
    status: 'pass',
    message: `"${codebase.name}" (runs in place) — ${reposMsg}`,
  };
}

export interface ProviderDeps {
  listUserProviderKeys: (
    userId: string
  ) => Promise<{ provider: string; kind: string; label: string | null }[]>;
  // `platform` is the literal 'cli' — this check resolves the CLI identity only,
  // and narrowing it keeps the real (platform-union-typed) db fn assignable here.
  findOrCreateUserByPlatformIdentity: (
    platform: 'cli',
    id: string,
    name: string
  ) => Promise<{ id: string }>;
}

/**
 * Report how many AI-provider credentials the current CLI user has connected,
 * plus how to connect when none are. Skip (never fail) on any error — credential
 * status is informational, and a missing CLI identity or DB hiccup shouldn't make
 * `archon doctor` exit non-zero.
 */
export async function checkConnectedProviders(
  env: NodeJS.ProcessEnv = process.env,
  // Injected so tests can drive every branch without the dynamic @archon/core import.
  loadDeps: () => Promise<ProviderDeps> = defaultLoadProviderDeps
): Promise<CheckResult> {
  const label = 'AI credentials';
  const cliId = env.ARCHON_USER_ID || env.USER || env.USERNAME;
  if (!cliId) {
    return { label, status: 'skip', message: 'no CLI identity (set ARCHON_USER_ID or USER)' };
  }
  let deps: ProviderDeps;
  try {
    deps = await loadDeps();
  } catch (err) {
    return {
      label,
      status: 'skip',
      message: `could not load credential module: ${(err as Error).message}`,
    };
  }
  try {
    const user = await deps.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
    const rows = await deps.listUserProviderKeys(user.id);
    if (rows.length === 0) {
      return {
        label,
        status: 'skip',
        message: 'none connected — run: archon ai login <vendor>  or  archon ai key set <vendor>',
      };
    }
    const summary = rows.map(r => `${r.provider}(${r.kind})`).join(', ');
    return { label, status: 'pass', message: `${rows.length} connected: ${summary}` };
  } catch (err) {
    return {
      label,
      status: 'skip',
      message: `could not read credentials: ${(err as Error).message}`,
    };
  }
}

async function defaultLoadProviderDeps(): Promise<ProviderDeps> {
  // Lazy imports for the same reason as defaultLoadDatabaseDeps.
  const { listUserProviderKeys } = await import('@archon/core');
  const userDb = await import('@archon/core/db/users');
  return {
    listUserProviderKeys,
    findOrCreateUserByPlatformIdentity: userDb.findOrCreateUserByPlatformIdentity,
  };
}

export async function checkWorkspaceWritable(): Promise<CheckResult> {
  const label = 'Workspace';
  const home = getArchonHome();
  const probe = join(home, `.doctor-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(probe, 'ok');
  } catch (err) {
    return { label, status: 'fail', message: `${home} not writable: ${(err as Error).message}` };
  }
  try {
    rmSync(probe, { force: true });
  } catch (err) {
    // Deletion failure is cosmetic — the write succeeded, so the dir is
    // writable. Log so repeated failures leave a diagnostic trace instead of
    // silently accumulating .doctor-probe-* files in ARCHON_HOME.
    getLog().warn({ probe, err }, 'doctor.workspace_probe_delete_failed');
  }
  return { label, status: 'pass', message: `${home} is writable` };
}

export async function checkBundledDefaults(): Promise<CheckResult> {
  const label = 'Bundled defaults';
  try {
    const { BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } = await import('@archon/workflows/defaults');
    const commands = Object.keys(BUNDLED_COMMANDS).length;
    const workflows = Object.keys(BUNDLED_WORKFLOWS).length;
    return {
      label,
      status: 'pass',
      message: `${workflows} workflow(s), ${commands} command(s) loaded`,
    };
  } catch (err) {
    return { label, status: 'fail', message: `failed to load: ${(err as Error).message}` };
  }
}

export async function checkTelemetry(): Promise<CheckResult> {
  const label = 'Telemetry';
  const status = getTelemetryStatus();
  if (status.enabled) {
    return {
      label,
      status: 'pass',
      message: `anonymous, ${status.keySource} key (opt out: DO_NOT_TRACK=1)`,
    };
  }
  // `status` is narrowed to the disabled arm here, so `disabledReason` is
  // guaranteed non-null — no fallback branch needed.
  const reasonText: Record<typeof status.disabledReason, string> = {
    ARCHON_TELEMETRY_DISABLED: 'ARCHON_TELEMETRY_DISABLED=1',
    DO_NOT_TRACK: 'DO_NOT_TRACK=1',
    CI: 'CI=true (auto-disabled)',
    POSTHOG_API_KEY: 'POSTHOG_API_KEY set to an opt-out value',
  };
  return { label, status: 'skip', message: `disabled (${reasonText[status.disabledReason]})` };
}

export async function checkSlack(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'Slack';
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    return { label, status: 'skip', message: 'no SLACK_BOT_TOKEN set' };
  }
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (body.ok) {
      return { label, status: 'pass', message: 'auth.test OK' };
    }
    return { label, status: 'fail', message: `auth.test rejected: ${body.error ?? 'unknown'}` };
  } catch (err) {
    // Network errors → skip, not fail — best-effort by design.
    return {
      label,
      status: 'skip',
      message: `ping skipped (${(err as Error).message})`,
    };
  }
}

export async function checkTelegram(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'Telegram';
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { label, status: 'skip', message: 'no TELEGRAM_BOT_TOKEN set' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (body.ok) {
      return { label, status: 'pass', message: 'getMe OK' };
    }
    return {
      label,
      status: 'fail',
      message: `getMe rejected: ${body.description ?? 'unknown'}`,
    };
  } catch (err) {
    return {
      label,
      status: 'skip',
      message: `ping skipped (${(err as Error).message})`,
    };
  }
}

function renderResult(r: CheckResult): string {
  const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '○';
  return `${icon} ${r.label}: ${r.message}`;
}

export async function doctorCommand(
  // Injected so tests can drive the exit-code contract and the
  // Promise.allSettled rejection branch with synthetic checks.
  checks?: (() => Promise<CheckResult>)[],
  // `--full` opts the OpenCode runtime probe in even when OpenCode isn't the
  // configured assistant. Does not boot the runtime — only widens the gate.
  full = false
): Promise<number> {
  console.log('archon doctor — verifying your setup\n');
  getLog().info('doctor.run_started');
  const env = process.env;

  const promises = checks
    ? checks.map(fn => fn())
    : [
        checkClaudeBinary(env),
        checkCodexBinary(env),
        checkGhAuth(env),
        checkPi(env),
        checkOpenCode(env, full),
        checkDatabase(),
        checkFolderProject(),
        checkConnectedProviders(env),
        checkWorkspaceWritable(),
        checkBundledDefaults(),
        checkTelemetry(),
        checkSlack(env),
        checkTelegram(env),
      ];

  // Promise.allSettled so one unexpected rejection doesn't skip remaining checks.
  const settled = await Promise.allSettled(promises);

  let failures = 0;
  for (const s of settled) {
    if (s.status === 'rejected') {
      failures++;
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      console.log(`✗ unknown: check threw: ${msg}`);
      getLog().error({ reason: s.reason }, 'doctor.check_threw_unexpectedly');
      continue;
    }
    if (s.value.status === 'fail') failures++;
    console.log(renderResult(s.value));
  }

  console.log('');
  if (failures === 0) {
    console.log('All checks passed.');
    getLog().info('doctor.run_completed');
    return 0;
  }
  console.log(`${failures} check(s) failed. Run \`archon setup\` to reconfigure.`);
  getLog().warn({ failures }, 'doctor.run_failed');
  return 1;
}
