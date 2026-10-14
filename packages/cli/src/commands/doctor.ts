import {
  installedProviders,
  noDefaultProviderMessage,
  MAINTAINED_PROVIDER_IDS,
  isMaintainedProvider,
  type ProviderRegistry,
} from '@archon/provider-contract';
import { getRegistration, providerRegistry } from '@archon/providers';
import { PluginRemoteError } from '@archon/provider-contract/plugin';
import { isProviderReceipt } from '@archon/plugin-manifest';
import { readReceipts } from '@archon/plugin-manifest/store';
/**
 * Doctor command - Verifies the local Archon setup.
 *
 * Also invoked from the end of `archon setup`; the setup wizard discards the
 * return value so a doctor failure does not abort setup (the env file was
 * already written successfully).
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFileAsync } from '@archon/git';
import {
  getArchonHome,
  createLogger,
  getTelemetryStatus,
  canonicalizeProjectPath,
  getPluginsPath,
  BUNDLED_VERSION,
  BUNDLED_IS_BINARY,
} from '@archon/paths';
import type { IAgentProvider } from '@archon/providers';
import type { Codebase, MergedConfig, SchemaVersionInfo } from '@archon/core';
import type { CredentialStatus } from '@archon/provider-contract';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.doctor');
  return cachedLog;
}

export interface CheckResult {
  label: string;
  /**
   * `warn` is a defect the operator should see that is not a failure: the
   * install works, but something about it is wrong or worth knowing. It does
   * not count toward the exit code.
   */
  status: 'pass' | 'warn' | 'fail' | 'skip';
  message: string;
}

/**
 * Report whether the global and repository `.archon/config.yaml` actually load.
 */
export async function checkConfigFiles(
  cwd: string = process.cwd(),
  // Injected so tests can drive both branches without the dynamic @archon/core
  // import or a config file on disk.
  load: (cwd: string) => Promise<Pick<MergedConfig, 'assistant'>> = defaultLoadMergedConfig
): Promise<CheckResult> {
  const label = 'Config files';
  try {
    const config = await load(cwd);
    return { label, status: 'pass', message: `valid (default assistant: ${config.assistant})` };
  } catch (err) {
    return { label, status: 'fail', message: (err as Error).message };
  }
}

/**
 * Warn when the configured default assistant is a deprecated provider. Skips
 * when the config cannot load: Config files already reports that failure.
 */
export async function checkProviderDeprecation(
  cwd: string = process.cwd(),
  load: (cwd: string) => Promise<Pick<MergedConfig, 'assistant'>> = defaultLoadMergedConfig
): Promise<CheckResult> {
  const label = 'Provider support';
  let assistant: string | undefined;
  try {
    assistant = (await load(cwd)).assistant;
  } catch {
    return { label, status: 'skip', message: 'config did not load' };
  }
  if (assistant === undefined)
    return { label, status: 'skip', message: 'no default provider configured' };
  const notice = getRegistration(assistant).deprecationNotice;
  return notice
    ? { label, status: 'warn', message: notice }
    : { label, status: 'pass', message: `${assistant} is supported` };
}

async function defaultLoadMergedConfig(cwd: string): Promise<MergedConfig> {
  // Lazy import so doctor doesn't pull the full @archon/core graph for an
  // unrelated check.
  const { loadConfig } = await import('@archon/core');
  return loadConfig(cwd);
}

export async function checkInstalledProviders(
  registry: ProviderRegistry = providerRegistry,
  loadVersions: () => Promise<ReadonlyMap<string, string>> = async () =>
    new Map(
      (await readReceipts(getPluginsPath()))
        .filter(isProviderReceipt)
        .map(receipt => [receipt.descriptor.id, receipt.descriptor.version])
    )
): Promise<CheckResult> {
  const label = 'Installed providers';
  try {
    const versions = await loadVersions();
    const installed = installedProviders(registry);
    const unavailable = [...new Set([...MAINTAINED_PROVIDER_IDS, ...versions.keys()])]
      .map(id => registry.unavailable?.(id))
      .filter((reason): reason is string => reason !== undefined);
    const lines = installed.map(provider => {
      const version =
        !BUNDLED_IS_BINARY && isMaintainedProvider(provider.id)
          ? BUNDLED_VERSION
          : (versions.get(provider.id) ??
            (provider.builtIn ? BUNDLED_VERSION : 'version not reported'));
      return `${provider.id} (${version})`;
    });
    return {
      label,
      status: installed.length === 0 || unavailable.length > 0 ? 'fail' : 'pass',
      message: [
        installed.length === 0 ? noDefaultProviderMessage(registry) : lines.join(', '),
        ...unavailable,
      ].join('\n    '),
    };
  } catch (error) {
    return {
      label,
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

type ProviderSelection = Pick<MergedConfig, 'assistants'> &
  Partial<Pick<MergedConfig, 'assistant'>>;

/** The default assistant, or an `assistants.<id>` entry with settings in it. */
function selectsProvider(config: ProviderSelection, id: string): boolean {
  return config.assistant === id || Object.keys(config.assistants[id] ?? {}).length > 0;
}

export async function checkProviderDiagnostics(
  id: string,
  provider?: Pick<IAgentProvider, 'diagnose'>,
  load: () => Promise<ProviderSelection> = () => defaultLoadMergedConfig(process.cwd()),
  signal: AbortSignal = AbortSignal.timeout(20_000)
): Promise<CheckResult[]> {
  const label = `${id} diagnostics`;
  try {
    let config: ProviderSelection | undefined;
    if (!provider) {
      const registration = getRegistration(id);
      // A deprecated provider stays bundled whether or not anyone uses it, so its
      // runtime is only worth checking for a user who selected or configured it.
      // A config that fails to load selects nothing; the Config files check reports it.
      if (registration.deprecationNotice) {
        config = await load().catch(() => undefined);
        if (!config || !selectsProvider(config, id)) return [];
      }
      // The factory, not getAgentProvider: a diagnostic is not a run, so it must not
      // report the deprecation notice the Provider support check already shows.
      provider = registration.factory();
    }
    if (!provider.diagnose) return [{ label, status: 'skip', message: 'no diagnostics hook' }];
    config ??= await load();
    const diagnostics = await provider.diagnose({ assistantConfig: config.assistants[id], signal });
    return diagnostics.checks.map(check => ({
      label: `${id}: ${check.label}`,
      status: check.status === 'ok' ? 'pass' : check.status,
      message: `${check.message}${check.remedy ? ` Remedy: ${check.remedy}` : ''}`,
    }));
  } catch (error) {
    if (error instanceof PluginRemoteError && error.code === -32601)
      return [{ label, status: 'skip', message: 'no diagnostics hook' }];
    return [
      { label, status: 'fail', message: error instanceof Error ? error.message : String(error) },
    ];
  }
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

export interface AssistantLoginDeps {
  assistant: string;
  assistantConfig?: Parameters<IAgentProvider['checkCredential']>[0]['assistantConfig'];
  model?: string;
  /**
   * The credential vendor the configured model uses; undefined when Archon config names no
   * model or the model's provider has no credential vendor (a Pi models.json provider).
   */
  vendor?: string;
  /** Vendors of the user's connected credentials that this assistant can use, as delivery names them. */
  connectedVendors: readonly string[];
  provider: Pick<IAgentProvider, 'checkCredential'>;
}

export async function checkAssistantLogin(
  env: NodeJS.ProcessEnv = process.env,
  loadDeps: (env: NodeJS.ProcessEnv) => Promise<AssistantLoginDeps> = defaultLoadAssistantLoginDeps
): Promise<CheckResult> {
  const label = 'Assistant login';
  try {
    const deps = await loadDeps(env);
    if (deps.vendor !== undefined && deps.connectedVendors.includes(deps.vendor)) {
      return {
        label,
        status: 'pass',
        message: `${deps.assistant}: uses the credential connected in Archon`,
      };
    }
    const status = await deps.provider.checkCredential({
      assistantConfig: deps.assistantConfig,
      model: deps.model,
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      signal: AbortSignal.timeout(20_000),
    });
    // A run receives every connected credential, and the model picks the one it uses. With
    // no model in Archon config (Pi falls back to its own default), doctor cannot tell
    // whether a connected credential covers a missing native login, so it warns instead.
    const connectedHint =
      deps.model === undefined && deps.connectedVendors.length > 0
        ? ` A run also receives your connected ${deps.connectedVendors.join(', ')} credential and uses it if its model is from that vendor; set a model in assistants.${deps.assistant} so doctor can tell.`
        : undefined;
    switch (status.state) {
      case 'usable':
        return { label, status: 'pass', message: `${deps.assistant}: usable` };
      case 'not_checked':
        // Nothing was verified, so this is not a pass.
        return { label, status: 'skip', message: `${deps.assistant}: not checked` };
      case 'check_failed':
        return {
          label,
          status: 'warn',
          message: `${deps.assistant}: could not be verified. ${status.evidence}`,
        };
      case 'unusable':
        return connectedHint
          ? {
              label,
              status: 'warn',
              message: `${deps.assistant}: native login cannot be used. ${status.evidence}${connectedHint}`,
            }
          : {
              label,
              status: 'fail',
              message: `${deps.assistant}: cannot be used. ${status.evidence} Log in through ${deps.assistant} or connect a credential with \`archon ai\`.`,
            };
      case 'not_connected':
        return connectedHint
          ? {
              label,
              status: 'warn',
              message: `${deps.assistant}: no native credential.${connectedHint}`,
            }
          : {
              label,
              status: 'fail',
              message: `${deps.assistant}: no native credential. Log in through ${deps.assistant} or connect a credential with \`archon ai\`.`,
            };
    }
  } catch (error) {
    return {
      label,
      status: 'warn',
      message: `could not check assistant login: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function defaultLoadAssistantLoginDeps(env: NodeJS.ProcessEnv): Promise<AssistantLoginDeps> {
  const config = await defaultLoadMergedConfig(process.cwd());
  if (config.assistant === undefined) throw new Error(noDefaultProviderMessage(providerRegistry));
  const { normalizeCredentialVendor } = await import('@archon/providers');
  const configuredModel = config.assistants[config.assistant]?.model;
  const model = typeof configuredModel === 'string' ? configuredModel : undefined;
  const registration = getRegistration(config.assistant);
  const { credentials } = registration;
  const usableVendors =
    credentials.kind === 'static' ? credentials.specs.map(spec => spec.vendor) : [];
  const cliId = env.ARCHON_USER_ID || env.USER || env.USERNAME;
  let connectedVendors: string[] = [];
  if (usableVendors.length > 0 && cliId) {
    try {
      const deps = await defaultLoadProviderDeps();
      const user = await deps.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
      const rows = await deps.listUserProviderKeys(user.id);
      // Delivery normalizes legacy agent-keyed rows to their vendor; so does this lookup.
      connectedVendors = [
        ...new Set(rows.map(row => normalizeCredentialVendor(row.provider))),
      ].filter(vendor => usableVendors.includes(vendor));
    } catch (err) {
      // Best-effort, as in the Codex credential lookup: a failed lookup must not hide the
      // native login check, which runs as if nothing were connected. The AI credentials
      // check runs the same lookup and shows its error. The lookup reads only credential
      // metadata, never key material, so its error is safe to log.
      getLog().debug({ err }, 'doctor.assistant_login_credential_lookup_failed');
    }
  }
  return {
    assistant: config.assistant,
    assistantConfig: { ...(config.assistants[config.assistant] ?? {}) },
    model,
    vendor: credentials.vendorFor(model),
    connectedVendors,
    // The factory, not getAgentProvider: a credential check is not a run, so it must not
    // log the deprecation notice the Provider support check already shows.
    provider: registration.factory(),
  };
}

export interface DatabaseDeps {
  pool: { query: (sql: string) => Promise<unknown> };
  getDatabaseType: () => string;
  getSchemaVersion: () => Promise<SchemaVersionInfo | null>;
}

/**
 * Render the schema vintage (#2316) for the Database check. A bug report that can
 * state which build created the database — and which last wrote to it — is the whole
 * point, so an unknown or unrecorded vintage is reported as such rather than hidden.
 */
function describeSchemaVersion(info: SchemaVersionInfo | null): string {
  if (!info) return 'schema vintage not recorded';
  const created = info.createdAppVersion ?? '<unknown — predates version tracking>';
  return `schema created by ${created}, last applied by ${info.appVersion}`;
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

    // The vintage is diagnostic metadata: a failure to read it must not turn a
    // reachable database into a failed check. Degrade the message instead.
    let schemaInfo: SchemaVersionInfo | null = null;
    try {
      schemaInfo = await deps.getSchemaVersion();
    } catch (err) {
      getLog().warn({ err }, 'doctor.schema_version_read_failed');
    }

    return {
      label,
      status: 'pass',
      message: `reachable (${dbType}); ${describeSchemaVersion(schemaInfo)}`,
    };
  } catch (err) {
    getLog().error({ err }, 'doctor.db_query_failed');
    return { label, status: 'fail', message: `not reachable: ${(err as Error).message}` };
  }
}

async function defaultLoadDatabaseDeps(): Promise<DatabaseDeps> {
  // Lazy import so doctor doesn't pull in the full @archon/core graph just to
  // print --help or run a different check.
  const { pool, getDatabaseType, getSchemaVersion } = await import('@archon/core');
  return { pool, getDatabaseType, getSchemaVersion };
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
  // Same canonicalizer as the CLI gate and as registration, so doctor reports
  // the project the rest of the CLI will actually resolve here — a raw cwd
  // misses a symlinked or Windows short-name root that is registered (#2927).
  const canonicalCwd = await canonicalizeProjectPath(cwd);
  let codebase: FolderCodebase | null;
  try {
    codebase =
      (await deps.findCodebaseByDefaultCwd(canonicalCwd)) ??
      (await deps.findCodebaseByPathPrefix(canonicalCwd));
  } catch (err) {
    getLog().debug({ err, cwd: canonicalCwd }, 'doctor.folder_project_lookup_failed');
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
  getStoredCredentialStatus: (userId: string, vendor: string) => Promise<CredentialStatus>;
  // `platform` is the literal 'cli' — this check resolves the CLI identity only,
  // and narrowing it keeps the real (platform-union-typed) db fn assignable here.
  findOrCreateUserByPlatformIdentity: (
    platform: 'cli',
    id: string,
    name: string
  ) => Promise<{ id: string }>;
}

/** One line for a connected credential: its state, and what to do when it fails. */
function describeStoredCredential(
  row: { provider: string; kind: string },
  status: CredentialStatus
): string {
  const name = `${row.provider} (${row.kind})`;
  const reconnect =
    row.kind === 'oauth' ? `archon ai login ${row.provider}` : `archon ai key set ${row.provider}`;
  switch (status.state) {
    case 'usable':
      return `${name}: usable`;
    case 'not_connected':
      return `${name}: no longer connected`;
    case 'not_checked':
      return `${name}: not checked`;
    case 'unusable':
      return `${name}: cannot be used. Reconnect: ${reconnect}. Cause: ${status.evidence}`;
    case 'check_failed':
      return `${name}: could not be verified. If it persists, reconnect: ${reconnect}. Cause: ${status.evidence}`;
  }
}

/**
 * Check every AI-provider credential the current CLI user connected, the way a run
 * would use it: decrypt, and refresh an expired OAuth grant (saving any rotation).
 * Fails when a credential cannot be used and warns when one could not be verified.
 * Skips when there is no CLI identity, nothing is connected, or the database cannot
 * be read, so a DB hiccup does not make `archon doctor` exit non-zero.
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
  let checked: { row: { provider: string; kind: string }; status: CredentialStatus }[];
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
    checked = await Promise.all(
      rows.map(async row => ({
        row,
        status: await deps.getStoredCredentialStatus(user.id, row.provider),
      }))
    );
  } catch (err) {
    return {
      label,
      status: 'skip',
      message: `could not read credentials: ${(err as Error).message}`,
    };
  }
  const states = checked.map(c => c.status.state);
  const status = states.includes('unusable')
    ? 'fail'
    : states.includes('check_failed')
      ? 'warn'
      : 'pass';
  const lines = checked.map(c => `\n    ${describeStoredCredential(c.row, c.status)}`);
  return { label, status, message: `${checked.length} connected${lines.join('')}` };
}

async function defaultLoadProviderDeps(): Promise<ProviderDeps> {
  // Lazy imports for the same reason as defaultLoadDatabaseDeps.
  const { listUserProviderKeys, getStoredCredentialStatus } = await import('@archon/core');
  const userDb = await import('@archon/core/db/users');
  return {
    listUserProviderKeys,
    getStoredCredentialStatus,
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

const RETIRED_SKILL_ROOTS = ['archon', 'manage-run'] as const;
const CURRENT_SKILL_ROOT = 'archon-cli';

type LoadBundledSkillFiles = () => Promise<Record<string, string>>;

const loadBundledSkillFiles: LoadBundledSkillFiles = async () =>
  (await import('../bundled-skill')).BUNDLED_SKILL_FILES;

function skillTreeMatches(skillRoot: string, bundledFiles: Record<string, string>): boolean {
  const unmatched = new Set(Object.keys(bundledFiles));
  const pending = [{ absolute: skillRoot, relative: '' }];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;

    for (const entry of readdirSync(directory.absolute, { withFileTypes: true })) {
      const absolute = join(directory.absolute, entry.name);
      const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push({ absolute, relative });
      } else if (
        !entry.isFile() ||
        !unmatched.delete(relative) ||
        readFileSync(absolute, 'utf-8') !== bundledFiles[relative]
      ) {
        return false;
      }
    }
  }

  return unmatched.size === 0;
}

/**
 * Catch the v0.10.0 skill migration that `archon skill install` performs but
 * upgrades never run: leftover `archon` / `manage-run` roots, or a missing
 * `archon-cli` replacement. Skip when this project has never installed skills.
 */
export async function checkArchonSkill(
  cwd: string = process.cwd(),
  loadFiles: LoadBundledSkillFiles = loadBundledSkillFiles
): Promise<CheckResult> {
  const label = 'Archon skill';
  const skillsRoots = [join(cwd, '.claude', 'skills'), join(cwd, '.agents', 'skills')];

  const retired: string[] = [];
  const installedRoots: string[] = [];
  const missingRoots: string[] = [];

  for (const skillsRoot of skillsRoots) {
    if (!existsSync(skillsRoot)) {
      continue;
    }
    const currentRoot = join(skillsRoot, CURRENT_SKILL_ROOT);
    for (const name of RETIRED_SKILL_ROOTS) {
      if (existsSync(join(skillsRoot, name))) {
        retired.push(`${skillsRoot}/${name}`);
      }
    }
    (existsSync(currentRoot) ? installedRoots : missingRoots).push(skillsRoot);
  }

  if (retired.length > 0) {
    return {
      label,
      status: 'fail',
      message: `retired skill root(s) still present. Run \`archon skill install .\` to replace them with ${CURRENT_SKILL_ROOT}.`,
    };
  }

  if (missingRoots.length > 0) {
    return {
      label,
      status: 'fail',
      message: `${CURRENT_SKILL_ROOT} is missing from ${missingRoots.join(', ')}. Run \`archon skill install .\` to install the current skill in this project.`,
    };
  }

  if (installedRoots.length === 0) {
    return {
      label,
      status: 'skip',
      message:
        'not installed (run `archon skill install .` if you use Claude Code or Codex skills)',
    };
  }

  const bundledFiles = await loadFiles();
  for (const skillsRoot of installedRoots) {
    const currentRoot = join(skillsRoot, CURRENT_SKILL_ROOT);
    if (!skillTreeMatches(currentRoot, bundledFiles)) {
      return {
        label,
        status: 'fail',
        message: `${currentRoot} differs from the skill bundled with this Archon build. Run \`archon skill install .\` to update it.`,
      };
    }
  }

  return { label, status: 'pass', message: `${CURRENT_SKILL_ROOT} installed` };
}

function renderResult(r: CheckResult): string {
  const icon =
    r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'warn' ? '!' : '○';
  return `${icon} ${r.label}: ${r.message}`;
}

export async function doctorCommand(
  // Injected so tests can drive the exit-code contract and the
  // Promise.allSettled rejection branch with synthetic checks.
  checks?: (() => Promise<CheckResult | CheckResult[]>)[]
): Promise<number> {
  console.log('archon doctor — verifying your setup\n');
  getLog().info('doctor.run_started');
  const env = process.env;

  const promises = checks
    ? checks.map(fn => fn())
    : [
        checkConfigFiles(),
        checkInstalledProviders(),
        ...providerRegistry.list().map(provider => checkProviderDiagnostics(provider.id)),
        checkGhAuth(env),
        checkAssistantLogin(env),
        checkProviderDeprecation(),
        checkDatabase(),
        checkFolderProject(),
        checkConnectedProviders(env),
        checkWorkspaceWritable(),
        checkBundledDefaults(),
        checkArchonSkill(),
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
    for (const result of Array.isArray(s.value) ? s.value : [s.value]) {
      if (result.status === 'fail') failures++;
      console.log(renderResult(result));
    }
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
