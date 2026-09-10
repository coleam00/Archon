/**
 * Does the credential a run (or `archon doctor`) depends on actually work?
 *
 * Two stores are in scope, and only those two: Pi's `~/.pi/agent/auth.json` and the
 * credentials a user connected to Archon itself (`archon ai login|key set`). A runner
 * with its own credential store — Claude Code's, Codex's — authenticates through it,
 * and Archon deliberately does not read those (#3274). That boundary is why the gate
 * below reports "not verifiable here" rather than pretending, and why it never treats
 * silence as a pass.
 *
 * Nothing in this module puts a credential value into a message, a log field, or a
 * thrown error. Provider name, state, and expiry date only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@archon/paths';
import {
  PI_AMBIENT_VENDORS,
  PI_PROVIDER_ENV_VARS,
  PI_OAUTH_ENV_VARS,
  parsePiModelRef,
} from '@archon/providers';
import { normalizeCredentialVendor } from '@archon/core/credentials/delivery';
import type { StoredCredentialInspection } from '@archon/core';
import {
  assistantModelDefaults,
  collectNodeModelBindings,
  resolveWorkflowModelScope,
} from '@archon/workflows/node-model-resolution';
import type { ResolvedAiProfile } from '@archon/workflows/model-validation';
import type { DagNode, IncludeDirective } from '@archon/workflows/schemas/dag-node';
import type { WorkflowConfig } from '@archon/workflows/deps';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.credentials');
  return cachedLog;
}

export interface PiCredentialStatus {
  provider: string;
  kind: 'oauth' | 'api_key';
  status: 'valid' | 'expired' | 'invalid' | 'unreachable';
  expires?: number;
  message?: string;
}

export interface PiAuthInspectionResult {
  exists: boolean;
  error?: string;
  entries: PiCredentialStatus[];
}

export function formatExpiryDate(ms: number): string {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return String(ms);
  const day = d.getUTCDate();
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const month = monthNames[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

export function parseExpires(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) {
    // If epoch seconds (10 digits), convert to ms
    return val < 10_000_000_000 ? val * 1000 : val;
  }
  if (typeof val === 'string') {
    const num = Number(val);
    if (!isNaN(num) && Number.isFinite(num)) {
      return num < 10_000_000_000 ? num * 1000 : num;
    }
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) return parsed;
  }
  return undefined;
}

export function defaultReadAuthJson(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Ask Pi itself whether a credential still works, for an entry that carries no
 * `expires` to compare against.
 *
 * Classification comes from the structured channel only — the `--json` payload Pi
 * prints, or the errno embedded in a spawn failure. An error this cannot place is
 * `unreachable` ("no answer"), never `invalid` ("the credential is dead"): matching
 * vendor prose would let a reworded message silently flip a run-affecting verdict.
 * A missing `pi` binary is exactly that no-answer case, not a pass.
 */
export async function probePiCredential(
  provider: string
): Promise<'ready' | 'invalid' | 'unreachable'> {
  const readStatus = (stdout: unknown): 'ready' | 'invalid' | undefined => {
    if (typeof stdout !== 'string' || stdout.trim().length === 0) return undefined;
    try {
      const parsed = JSON.parse(stdout) as { status?: unknown };
      if (parsed.status === 'ready') return 'ready';
      return typeof parsed.status === 'string' ? 'invalid' : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const { execFileAsync } = await import('@archon/git');
    const { stdout } = await execFileAsync(
      'pi',
      ['auth', 'check', '--provider', provider, '--json'],
      { timeout: 5000 }
    );
    return readStatus(stdout) ?? 'unreachable';
  } catch (err) {
    // A non-zero exit still carries Pi's `--json` verdict on stdout; read that before
    // giving up, so "credential is invalid" doesn't arrive as "could not check".
    const fromStdout = readStatus((err as { stdout?: unknown }).stdout);
    if (fromStdout) return fromStdout;
    return 'unreachable';
  }
}

export async function inspectPiAuthJson(
  authJsonPath: string,
  now: number = Date.now(),
  readFn: (path: string) => string | null = defaultReadAuthJson,
  probeFn?: (provider: string) => Promise<'ready' | 'invalid' | 'unreachable'>
): Promise<PiAuthInspectionResult> {
  const content = readFn(authJsonPath);
  if (content === null) {
    return { exists: false, entries: [] };
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // Deliberately NOT the parser's message: a JSON syntax error quotes the source text
    // around the fault, and every byte of this file is a credential.
    return { exists: true, error: 'not valid JSON', entries: [] };
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { exists: true, error: 'expected JSON object', entries: [] };
  }

  const entries: PiCredentialStatus[] = [];
  for (const [provider, rawCred] of Object.entries(data as Record<string, unknown>)) {
    if (typeof rawCred !== 'object' || rawCred === null) continue;
    const cred = rawCred as Record<string, unknown>;
    const type = cred.type;

    if (type === 'oauth') {
      const expires = parseExpires(cred.expires);
      if (expires !== undefined) {
        if (now >= expires) {
          entries.push({
            provider,
            kind: 'oauth',
            status: 'expired',
            expires,
            message: `${provider} credential expired ${formatExpiryDate(expires)}`,
          });
        } else {
          entries.push({
            provider,
            kind: 'oauth',
            status: 'valid',
            expires,
          });
        }
      } else {
        // OAuth credential with no expires field
        if (probeFn) {
          try {
            const probeResult = await probeFn(provider);
            if (probeResult === 'ready') {
              entries.push({ provider, kind: 'oauth', status: 'valid' });
            } else if (probeResult === 'unreachable') {
              entries.push({
                provider,
                kind: 'oauth',
                status: 'unreachable',
                message: `${provider} unreachable`,
              });
            } else {
              entries.push({
                provider,
                kind: 'oauth',
                status: 'invalid',
                message: `${provider} credential invalid`,
              });
            }
          } catch (err) {
            entries.push({
              provider,
              kind: 'oauth',
              status: 'unreachable',
              message: `${provider} unreachable (${(err as Error).message})`,
            });
          }
        } else {
          if (typeof cred.access === 'string' && cred.access.length > 0) {
            entries.push({ provider, kind: 'oauth', status: 'valid' });
          } else {
            entries.push({
              provider,
              kind: 'oauth',
              status: 'invalid',
              message: `${provider} credential invalid (missing access token)`,
            });
          }
        }
      }
    } else if (type === 'api_key') {
      if (typeof cred.key === 'string' && cred.key.trim().length > 0) {
        entries.push({ provider, kind: 'api_key', status: 'valid' });
      } else {
        entries.push({
          provider,
          kind: 'api_key',
          status: 'invalid',
          message: `${provider} API key missing or empty`,
        });
      }
    }
  }

  return { exists: true, entries };
}

function readPiSettingsDefaultProvider(): string | undefined {
  try {
    const settingsPath = join(homedir(), '.pi', 'agent', 'settings.json');
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        defaultProvider?: unknown;
      };
      if (typeof parsed.defaultProvider === 'string' && parsed.defaultProvider.trim().length > 0) {
        return parsed.defaultProvider.trim();
      }
    }
  } catch {
    // non-fatal
  }
  return undefined;
}

/** One credential a run needs: which runner will ask for it, and whose it is. */
export interface RequiredCredential {
  /** The provider an AI node resolves to (`pi`, `claude`, `codex`, …). */
  runner: string;
  /**
   * The vendor whose credential that runner presents (`anthropic`, `openrouter`, …).
   * Vendor-canonical, so it matches both `auth.json` keys and connected-credential rows.
   */
  vendor: string;
}

/** The parts of a loaded workflow provider resolution reads. */
export interface WorkflowShape {
  provider?: string;
  model?: string;
  nodes?: readonly (DagNode | IncludeDirective)[];
}

export interface WorkflowResolutionOptions {
  config?: WorkflowConfig;
  aiProfile?: ResolvedAiProfile;
}

/**
 * The credentials a workflow's AI nodes will actually need.
 *
 * Node traversal and provider/model resolution come from
 * `collectNodeModelBindings` — the executor's own chain — so a `command:` node, a
 * `loop_group` body, and a gate's rework reprompt are seen exactly as the run sees
 * them, and a tier or `@alias` resolves to the provider it will really run on.
 *
 * A `pi` node is asked for its MODEL's vendor, because that is whose key Pi presents;
 * every other runner maps through `normalizeCredentialVendor` (claude → anthropic,
 * codex → openai). A `pi` node whose vendor cannot be resolved is dropped with a log:
 * Pi picks its backend at runtime, and guessing one here would gate the wrong key.
 */
export function collectWorkflowRequiredCredentials(
  workflow: WorkflowShape,
  options?: WorkflowResolutionOptions
): RequiredCredential[] {
  const config = options?.config;
  const assistantModels = config ? assistantModelDefaults(config) : {};
  const scope = resolveWorkflowModelScope(
    workflow,
    config?.assistant ?? 'claude',
    assistantModels,
    options?.aiProfile
  );
  const bindings = collectNodeModelBindings(
    workflow.nodes ?? [],
    scope,
    assistantModels,
    options?.aiProfile
  );

  const required = new Map<string, RequiredCredential>();
  for (const { provider, model } of bindings) {
    let vendor: string | undefined;
    if (provider === 'pi') {
      vendor =
        (model ? parsePiModelRef(model)?.provider : undefined) ?? readPiSettingsDefaultProvider();
      if (!vendor) {
        getLog().debug({ model }, 'cli.credential_preflight_pi_vendor_unresolved');
        continue;
      }
    } else {
      vendor = normalizeCredentialVendor(provider);
    }
    required.set(`${provider} ${vendor}`, { runner: provider, vendor });
  }
  return [...required.values()];
}

/**
 * What the stores Archon inspects prove about one credential.
 *
 * `unverifiable` and `absent` are separate on purpose. `unverifiable` means a store
 * held something and would not give up a usable answer — a corrupt row, a rotated
 * encryption key, an unreadable `auth.json`; the launcher refuses on it. `absent`
 * means no store Archon reads holds anything, which for a runner with its own
 * credential store is the normal, healthy state.
 */
type CredentialVerdict =
  | { kind: 'usable' }
  | { kind: 'unusable'; reason: string }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'absent' };

function verdictFromPiAuthEntry(entry: PiCredentialStatus): CredentialVerdict {
  switch (entry.status) {
    case 'valid':
      return { kind: 'usable' };
    case 'expired':
      return {
        kind: 'unusable',
        reason: `credential expired${entry.expires !== undefined ? ` ${formatExpiryDate(entry.expires)}` : ''}`,
      };
    case 'invalid':
      return { kind: 'unusable', reason: entry.message ?? 'credential invalid' };
    case 'unreachable':
      return { kind: 'unverifiable', reason: entry.message ?? 'provider unreachable' };
  }
}

function verdictFromStoredCredential(inspection: StoredCredentialInspection): CredentialVerdict {
  switch (inspection.status) {
    case 'missing':
      return { kind: 'absent' };
    case 'valid':
      return { kind: 'usable' };
    case 'expired':
      return {
        kind: 'unusable',
        reason: `connected credential expired ${formatExpiryDate(inspection.expires)}`,
      };
    case 'undetermined':
      return { kind: 'unverifiable', reason: inspection.reason };
  }
}

/**
 * Inspect the connected-credential row for a vendor through core's own inspector, so
 * the CLI never re-derives decrypt-and-compare. Returns `missing` when this install has
 * no CLI identity to look one up for.
 */
async function inspectConnectedCredential(
  vendor: string,
  env: NodeJS.ProcessEnv,
  now: number
): Promise<StoredCredentialInspection> {
  const cliId = env.ARCHON_USER_ID || env.USER || env.USERNAME;
  if (!cliId) return { status: 'missing' };
  let userId: string;
  try {
    const userDb = await import('@archon/core/db/users');
    userId = (await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId)).id;
  } catch (err) {
    // The identity store failed, which says nothing about any credential — and this
    // boundary cannot explain a database or module failure. Report no connected
    // credential and log the real cause: the run creates its own row seconds later and
    // fails there naming the database, rather than blaming the user's key.
    getLog().warn({ err: err as Error, vendor }, 'cli.credential_preflight_identity_unavailable');
    return { status: 'missing' };
  }
  const { inspectStoredProviderCredential } = await import('@archon/core');
  return inspectStoredProviderCredential(userId, vendor, now);
}

export interface CredentialGateOptions extends WorkflowResolutionOptions {
  env?: NodeJS.ProcessEnv;
  authJsonPath?: string;
  now?: number;
  readAuthJson?: (path: string) => string | null;
  /** Injected by tests; defaults to the connected-credential store. */
  inspectConnected?: (vendor: string) => Promise<StoredCredentialInspection>;
}

/**
 * Refuse to launch a run whose credentials Archon can see are broken.
 *
 * Every required credential resolves to one of four verdicts, and only `usable` and a
 * documented `absent` let the run through. There is no fall-through: a store that
 * answered "I can't tell you" blocks, because the alternative is a gate that reports
 * success for the one condition it exists to catch.
 *
 * The one deliberate pass is `absent` for a runner that keeps its own credential store
 * (Claude Code, Codex) or a Pi vendor authenticated from an ambient cloud chain. Archon
 * reads neither, so it has nothing to judge; the decision is logged at
 * `cli.credential_preflight_unverified` and the run fails at its first node the way it
 * did before this gate existed. For `pi`, absence IS the verdict — Pi authenticates
 * from these stores and nowhere else.
 */
export async function assertWorkflowCredentialsValid(
  workflow: WorkflowShape & { name: string },
  options?: CredentialGateOptions
): Promise<void> {
  const env = options?.env ?? process.env;
  const now = options?.now ?? Date.now();
  const readFn = options?.readAuthJson ?? defaultReadAuthJson;
  const inspectConnected =
    options?.inspectConnected ??
    ((vendor: string): Promise<StoredCredentialInspection> =>
      inspectConnectedCredential(vendor, env, now));

  const required = collectWorkflowRequiredCredentials(workflow, options);
  if (required.length === 0) return;

  const authJsonPath =
    options?.authJsonPath ??
    env.ARCHON_PI_AUTH_PATH ??
    join(homedir(), '.pi', 'agent', 'auth.json');
  const piAuth = await inspectPiAuthJson(authJsonPath, now, readFn);

  for (const { runner, vendor } of required) {
    const verdict = await verifyRequiredCredential(runner, vendor, env, piAuth, inspectConnected);
    if (verdict.kind === 'usable') continue;
    if (verdict.kind === 'unusable') {
      throw new Error(`${vendor} ${verdict.reason}. ${reconnectHint(vendor)}`);
    }
    if (verdict.kind === 'unverifiable') {
      throw new Error(
        `could not verify the ${vendor} credential this run needs: ${verdict.reason}. ` +
          reconnectHint(vendor)
      );
    }
    // absent
    if (runner === 'pi' && !PI_AMBIENT_VENDORS.includes(vendor)) {
      throw new Error(
        `no ${vendor} credential found for this run. ` +
          `Pi reads credentials from ~/.pi/agent/auth.json, ${PI_PROVIDER_ENV_VARS[vendor] ?? 'the vendor API-key variable'}, ` +
          `or a credential connected to Archon. ${reconnectHint(vendor)}`
      );
    }
    getLog().info(
      { runner, vendor, workflow: workflow.name },
      'cli.credential_preflight_unverified'
    );
  }
}

function reconnectHint(vendor: string): string {
  return `Reconnect with \`archon ai login ${vendor}\` or \`archon ai key set ${vendor}\`.`;
}

async function verifyRequiredCredential(
  runner: string,
  vendor: string,
  env: NodeJS.ProcessEnv,
  piAuth: PiAuthInspectionResult,
  inspectConnected: (vendor: string) => Promise<StoredCredentialInspection>
): Promise<CredentialVerdict> {
  // 1. An env var the runner will read wins outright — it is what the process gets.
  for (const key of [PI_OAUTH_ENV_VARS[vendor], PI_PROVIDER_ENV_VARS[vendor]]) {
    if (key && (env[key] ?? '').trim().length > 0) return { kind: 'usable' };
  }

  // 2. Pi's own store — for Pi nodes only. Another runner authenticates from its own
  // store, so an entry here would not be the credential it presents, and a corrupt file
  // here is not a reason to refuse its run.
  if (runner === 'pi' && piAuth.exists) {
    if (piAuth.error) {
      return { kind: 'unverifiable', reason: `~/.pi/agent/auth.json is ${piAuth.error}` };
    }
    const entry = piAuth.entries.find(e => e.provider === vendor);
    if (entry) return verdictFromPiAuthEntry(entry);
  }

  // 3. A credential connected to Archon itself.
  return verdictFromStoredCredential(await inspectConnected(vendor));
}
