/**
 * Which model and which credential a Pi call runs with. A turn and the login check
 * resolve both here, so they read the same auth store and models config and reach
 * the same credential decision.
 *
 * Only type imports from the Pi SDK: callers pass the dynamically imported module
 * (see the lazy-load note in ./provider.ts).
 */
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { createLogger } from '@archon/paths';
import type { CredentialStatus } from '@archon/provider-contract';
import type { ModelsErrorCode } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ClassifiedProviderError } from '../../shared/failure';
import { PI_AUTH_PATH_ENV } from './auth-path-env';
import { parsePiModelRef } from './model-ref';
// Pi provider id → env var name used by pi-ai's getEnvApiKey(). Generated
// from the installed pi-ai SDK (full backend coverage) — see
// scripts/generate-pi-vendor-map.ts; `bun run check:pi-vendor-map` guards drift.
import { PI_PROVIDER_ENV_VARS } from './pi-vendor-map.generated';
import { createRequestModelRuntime, type RequestModelRuntime } from './request-auth';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

export function resolvePiModel(
  modelRef: string | undefined,
  cwd: string,
  piCodingAgent: Pick<typeof import('@earendil-works/pi-coding-agent'), 'SettingsManager'>
): NonNullable<ReturnType<typeof parsePiModelRef>> {
  if (!modelRef) {
    try {
      const settingsManager = piCodingAgent.SettingsManager.create(cwd);
      const settings = settingsManager.getGlobalSettings();
      // SettingsManager records malformed/unreadable settings via
      // drainErrors() rather than throwing, so a broken settings.json yields
      // default (empty) settings here. Drain + log them so that case is
      // visible instead of being swallowed behind the "requires a model"
      // error below (this branch may throw before the main settings load
      // that would otherwise surface them).
      for (const { scope, error: settingsErr } of settingsManager.drainErrors()) {
        getLog().warn({ scope, err: settingsErr }, 'pi.settings_default_model_read_error');
      }
      const provider = settings.defaultProvider?.trim();
      const modelId = settings.defaultModel?.trim();
      if (provider && modelId) {
        modelRef = `${provider}/${modelId}`;
        getLog().info({ modelRef }, 'pi.model_defaulted_from_settings');
      }
    } catch (err) {
      // Non-fatal: settings.json may be absent (user never ran `pi`) or
      // unreadable. Fall through to the explicit "requires a model" error
      // below rather than swallowing the missing-model condition.
      getLog().debug({ err }, 'pi.settings_default_model_read_failed');
    }
  }
  if (!modelRef) {
    throw new ClassifiedProviderError(
      'misconfigured',
      'Pi provider requires a model. Set `model` on the workflow node or `assistants.pi.model` in .archon/config.yaml, ' +
        'or select a default model in the `pi` CLI (writes defaultProvider/defaultModel to ~/.pi/agent/settings.json). ' +
        "Format: '<pi-provider-id>/<model-id>' (e.g. 'google/gemini-2.5-pro')."
    );
  }
  const parsed = parsePiModelRef(modelRef);
  if (!parsed) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Invalid Pi model ref: '${modelRef}'. Expected format '<pi-provider-id>/<model-id>' (e.g. 'google/gemini-2.5-pro').`
    );
  }

  return parsed;
}

/**
 * Whether `error` is pi-ai's `ModelsError` with `code`. Matched on its `name` and `code`
 * tokens, not `instanceof`: the coding agent can load its own copy of pi-ai (the install
 * resolves one per peer set), and an error from that copy is not an instance of ours.
 */
function isPiModelsError(error: unknown, code: ModelsErrorCode): boolean {
  return (
    error instanceof Error &&
    error.name === 'ModelsError' &&
    (error as Error & { code?: unknown }).code === code
  );
}

/**
 * Pi's own credential for `providerId`, resolved the way a turn resolves it. `checkAuth`
 * says whether a credential is configured; `getAuth` then resolves it, which refreshes an
 * OAuth grant and runs a command-backed key. `checkAuth` alone reports a models.json key
 * command as configured without running it, so a failing command would pass the check.
 * `apiKey` is the resolved key, which a turn inspects and reuses. Evidence has every
 * value in `credentialValues` redacted: Pi's errors can echo a configured credential.
 */
export async function resolvePiAuth(
  runtime: Pick<ModelRuntime, 'checkAuth' | 'getAuth' | 'listCredentials'>,
  providerId: string,
  credentialValues: readonly string[],
  signal?: AbortSignal
): Promise<{ status: CredentialStatus; apiKey?: string }> {
  // Without an Archon env mapping the provider may be a local one that needs no credential.
  const missing: CredentialStatus = {
    state: PI_PROVIDER_ENV_VARS[providerId] ? 'not_connected' : 'not_checked',
    source: 'native',
  };
  try {
    signal?.throwIfAborted();
    if (!(await runtime.checkAuth(providerId, { signal }))) {
      // Pi resolves a stored auth.json `!command` key while checking, and a failed command
      // leaves the stored entry with no key. That is a broken credential, not a missing one.
      // The store is read directly: Pi's availability snapshot stays empty when any other
      // provider's check throws.
      const stored = await runtime.listCredentials({ signal });
      if (stored.some(credential => credential.providerId === providerId)) {
        return {
          status: {
            state: 'unusable',
            source: 'native',
            evidence: `Pi's stored credential for '${providerId}' in auth.json did not resolve to a key. If it is a \`!command\`, check that the command succeeds and prints the key.`,
          },
        };
      }
      return { status: missing };
    }
    const resolution = await runtime.getAuth(providerId, { signal });
    // Pi runs a key command synchronously and ignores the signal, so a cancel during it
    // is only visible here.
    signal?.throwIfAborted();
    if (!resolution) return { status: { state: 'not_connected', source: 'native' } };
    return { status: { state: 'usable', source: 'native' }, apiKey: resolution.auth.apiKey };
  } catch (error) {
    return {
      status: {
        state: isPiModelsError(error, 'auth') ? 'unusable' : 'check_failed',
        source: 'native',
        evidence: redactCredentialValues(
          error instanceof Error ? error.message : String(error),
          credentialValues
        ),
      },
    };
  }
}

/**
 * The credential decision a Pi turn makes before its session starts; the login check
 * reports the same one. A model outside Pi's static catalog may belong to an extension
 * provider, which manages its credential outside Pi's store (kiro uses AWS SSO), so a
 * missing credential is not an error for it.
 */
export async function resolvePiTurnAuth(
  runtime: Pick<ModelRuntime, 'checkAuth' | 'getAuth' | 'listCredentials'>,
  providerId: string,
  catalogued: boolean,
  credentialValues: readonly string[],
  signal?: AbortSignal
): Promise<{ status: CredentialStatus; apiKey?: string }> {
  if (!catalogued) return { status: { state: 'not_checked', source: 'native' } };
  return resolvePiAuth(runtime, providerId, credentialValues, signal);
}

/**
 * The env a Pi turn authenticates with; the login check builds it here too, so both read
 * the same keys. `credentialEnv` layers request env over process.env over assistant config
 * env (a turn copies config env into process.env only where a key is unset). It supplies
 * the env key that overrides a stored credential, the per-run auth path, and the values a
 * models.json `${VAR}` reference is substituted with, and lists the values to redact from
 * Pi's errors.
 */
export interface PiAuthEnv {
  credentialEnv: Readonly<Record<string, string>>;
  credentialValues: readonly string[];
  protectedEnvKeys: readonly string[] | undefined;
  deliveredEnvKeys: readonly string[];
}

export function piAuthEnv(
  configEnv: Readonly<Record<string, string>> | undefined,
  requestEnv: Readonly<Record<string, string>> | undefined,
  protectedEnvKeys?: readonly string[],
  userCredentialEnvKeys?: readonly string[]
): PiAuthEnv {
  const credentialEnv: Record<string, string> = { ...configEnv };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) credentialEnv[key] = value;
  }
  // An empty request value counts as unset, as Pi's own `${VAR}` lookup
  // (`env[name] || process.env[name]`) treats it; an empty host value still hides config
  // env, because a turn copies config env into process.env only where a key is unset.
  for (const [key, value] of Object.entries(requestEnv ?? {})) {
    if (value) credentialEnv[key] = value;
  }
  return {
    credentialEnv,
    credentialValues: collectCredentialValues(credentialEnv, protectedEnvKeys),
    protectedEnvKeys,
    deliveredEnvKeys: (userCredentialEnvKeys ?? []).filter(key => Boolean(requestEnv?.[key])),
  };
}

export async function applyPiEnvOverride(
  runtime: Pick<ModelRuntime, 'setRuntimeApiKey'>,
  providerId: string,
  authEnv: PiAuthEnv,
  authPath: string | undefined
): Promise<void> {
  if (authPath && authEnv.deliveredEnvKeys.includes(PI_AUTH_PATH_ENV)) return;
  const env = authEnv.credentialEnv;
  const keyVar = PI_PROVIDER_ENV_VARS[providerId];
  const key = keyVar ? env[keyVar] : undefined;
  if (key) await runtime.setRuntimeApiKey(providerId, key);
}

/**
 * A Claude subscription runs only on the Claude provider (AGENTS.md: provider
 * authentication), so the Anthropic hint points there instead of at `pi /login`. Archon
 * stores one credential per vendor, so `archon ai key set anthropic` would replace the
 * user's subscription and is not offered either.
 */
export function piNotConnectedMessage(providerId: string): string {
  const envVarName = PI_PROVIDER_ENV_VARS[providerId];
  const envHint = envVarName
    ? ` Set ${envVarName} in the environment or codebase env vars (.archon/config.yaml env: section).`
    : '';
  if (providerId === 'anthropic') {
    return (
      `Pi auth: no Anthropic API key. Pi runs Anthropic models with an API key.${envHint} ` +
      'A Claude subscription runs on the Claude provider: use `provider: claude`.'
    );
  }
  return `Pi auth: no credentials for provider '${providerId}'.${envHint} Or run \`pi\` and type \`/login\` locally.`;
}

/**
 * The auth store a Pi call for `provider` reads: Archon's per-run file when it holds a
 * delivered credential for that provider, otherwise none (Pi's own auth.json).
 *
 * Pi reads exactly one store, and the per-run file holds only Archon's deliveries, so
 * using it for every provider would hide the user's `pi /login` for the others. Core
 * keys the file by Pi provider id (vendor ids are Pi provider ids), the same key Pi
 * reads, so an exact lookup is the whole test.
 */
function deliveredAuthPathFor(
  provider: string,
  deliveredAuthPath: string | undefined,
  readStoredCredential: (providerId: string, authPath: string) => unknown
): string | undefined {
  return deliveredAuthPath !== undefined &&
    readStoredCredential(provider, deliveredAuthPath) !== undefined
    ? deliveredAuthPath
    : undefined;
}

/**
 * The ModelRuntime a Pi turn authenticates with. The login check builds the same one, so
 * both read the same auth file and models config and see the same model catalog.
 *
 * Creating it refreshes the runtime, as Pi itself does. The refresh restores Pi's persisted
 * model catalog (models newer than the bundled one), which decides whether a model is
 * catalogued and so how its credential is checked. The refresh also runs Pi's availability
 * pass, which reads every provider's stored auth.json credential and so runs each stored
 * `!command` key, not only the selected provider's. Pi caches a stored command's output for
 * the life of the process. A models.json key command is not run here.
 *
 * Archon delivers per-user credentials (API keys + subscriptions) as a per-run auth.json
 * and points at it via ARCHON_PI_AUTH_PATH, an explicit authPath (not PI_CODING_AGENT_DIR)
 * so the user's models.json / settings.json at ~/.pi/agent/ are untouched. The file is
 * used only for a provider it holds an entry for; any other provider reads the user's own
 * auth.json, so the login check and the turn pick the same store. The path rides
 * the per-call env (the executor's per-user injection never writes to process.env), which
 * `piAuthEnv` layers over process.env for a shell-level override.
 *
 * For a provider with no Archon env mapping, `${VAR}` references in the user's models.json
 * are substituted from `credentialEnv` into a per-call models.json. The SDK resolves them
 * only from `process.env`, which holds neither request env nor, in the login check, config
 * env; substituting from the one env makes the check and a turn resolve the same value
 * (see `./request-auth.ts`). The caller must `release()` the result once it stops using
 * the runtime: the file lives as long as the runtime does.
 */
export async function createPiModelRuntime(
  piCodingAgent: typeof import('@earendil-works/pi-coding-agent'),
  provider: string,
  authEnv: PiAuthEnv,
  signal?: AbortSignal
): Promise<RequestModelRuntime & { authPath?: string }> {
  // Pi reads exactly one auth store. The per-run file holds only Archon's delivered
  // credentials, so it is used only when it holds one for this provider; otherwise Pi
  // reads the user's own auth.json, with its own locking and refresh write-back, so a
  // `pi /login` for this backend keeps working beside a credential delivered for another.
  const authPath = deliveredAuthPathFor(
    provider,
    authEnv.credentialEnv[PI_AUTH_PATH_ENV]?.trim() || undefined,
    piCodingAgent.readStoredCredential
  );
  const authoritativeCredential = Boolean(
    (authPath && authEnv.deliveredEnvKeys.includes(PI_AUTH_PATH_ENV)) ||
      (authEnv.deliveredEnvKeys.includes(PI_PROVIDER_ENV_VARS[provider] ?? '') &&
        authEnv.credentialEnv[PI_PROVIDER_ENV_VARS[provider] ?? ''])
  );
  const requestRuntime = await createRequestModelRuntime(
    options => piCodingAgent.ModelRuntime.create({ ...options, ...(signal ? { signal } : {}) }),
    authPath,
    authoritativeCredential || !PI_PROVIDER_ENV_VARS[provider]
      ? {
          provider,
          env: authEnv.credentialEnv,
          protectedEnvKeys: authEnv.protectedEnvKeys,
          authoritativeCredential,
        }
      : undefined
  );
  return { ...requestRuntime, authPath };
}

/** createPiModelRuntime for a turn, whose failure names the auth files to check. */
export async function openTurnModelRuntime(
  piCodingAgent: typeof import('@earendil-works/pi-coding-agent'),
  provider: string,
  authEnv: PiAuthEnv
): Promise<RequestModelRuntime & { authPath?: string }> {
  try {
    return await createPiModelRuntime(piCodingAgent, provider, authEnv);
  } catch (err) {
    const e = err as Error;
    getLog().error({ err: e, piProvider: provider }, 'pi.auth_storage_init_failed');
    // Unclassified: this step both reads the operator's files and writes a per-call
    // temp file, and this catch does not tell those failures apart.
    throw new Error(
      `Pi auth storage init failed: ${e.message}. Check that ~/.pi/agent/auth.json ` +
        '(or $PI_CODING_AGENT_DIR/auth.json) is valid JSON and readable.'
    );
  }
}

/**
 * Resolve a turn's credential, and refuse the turn when it has none it can use.
 * Per-request env vars override auth.json entries via setRuntimeApiKey — codebase-scoped
 * env vars win over the user's global Pi login. setRuntimeApiKey stays runtime-only (no
 * auth.json disk write, unlike AuthStorage.set).
 */
export async function authorizePiTurn(
  requestModelRuntime: RequestModelRuntime & { authPath?: string },
  provider: string,
  catalogued: boolean,
  authEnv: PiAuthEnv,
  signal: AbortSignal | undefined
): Promise<void> {
  const modelRuntime = requestModelRuntime.runtime;
  await applyPiEnvOverride(modelRuntime, provider, authEnv, requestModelRuntime.authPath);
  const { status: authStatus, apiKey } = await resolvePiTurnAuth(
    modelRuntime,
    provider,
    catalogued,
    authEnv.credentialValues,
    signal
  );
  switch (authStatus.state) {
    case 'not_connected':
      throw new ClassifiedProviderError('auth', piNotConnectedMessage(provider));
    case 'unusable':
      throw new ClassifiedProviderError('auth', authStatus.evidence);
    case 'check_failed':
      // An abort during the check is the caller's cancel, not a credential failure.
      if (signal?.aborted) throw new Error('Query aborted');
      throw new Error(authStatus.evidence);
    case 'not_checked':
      // A local provider that needs no credential, or an extension's model.
      if (catalogued) getLog().info({ piProvider: provider }, 'pi.auth_missing');
      break;
    case 'usable':
      if (apiKey) await pinModelsJsonCommandKey(modelRuntime, provider, apiKey, signal);
      break;
  }
}

/**
 * Pi runs a models.json key command on every getAuth, so the session's request
 * would run it again. Pin the key the check just resolved as a runtime-only key;
 * Pi reads a runtime key before models.json, so the command runs once per node.
 * The pinned key is fixed for the whole node: a short-lived token the command prints
 * can expire before a long node ends. Only a catalogued model reaches here; an
 * extension provider's model is not_checked, so Pi keeps running its key command
 * on each request.
 * A stored auth.json credential wins over models.json and may be an OAuth grant Pi
 * refreshes in session, so it is never pinned. The store is read directly: Pi's
 * auth status falls back to models.json when another provider's check throws.
 */
async function pinModelsJsonCommandKey(
  modelRuntime: ModelRuntime,
  provider: string,
  apiKey: string,
  signal: AbortSignal | undefined
): Promise<void> {
  if (modelRuntime.getProviderAuthStatus(provider).source !== 'models_json_command') return;
  const stored = await modelRuntime.listCredentials({ signal });
  if (stored.some(credential => credential.providerId === provider)) return;
  try {
    await modelRuntime.setRuntimeApiKey(provider, apiKey);
  } catch (error) {
    // Pi's CredentialSynchronizationError carries the key on `credential`; rethrow
    // without it so an error log cannot serialize the key.
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}
