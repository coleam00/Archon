/**
 * Builds the Pi AgentSession a turn prompts: the in-memory settings seed, the
 * ResourceLoader (with extension provider re-registration), and the session itself,
 * with extension flags, extension binding and the post-binding model lookup.
 *
 * This module imports Pi-dependent siblings, so ./turn.ts loads it dynamically
 * (see the lazy-load note in ./provider.ts). The Pi SDK itself arrives as a parameter.
 */
import { isAbsolute } from 'node:path';
import { createLogger } from '@archon/paths';
import type { DefaultResourceLoader, ExtensionError } from '@earendil-works/pi-coding-agent';
import type { MessageChunk } from '../../types';
import { ClassifiedProviderError } from '../../shared/failure';
import type { PiExtensionSettings } from './config';
import type { PiExtensionTurn } from './extension-error-broker';
import type { PiModelRef } from './model-ref';
import { freshPiToolNames } from './options-translator';
import { getUserModelsStorePath } from './request-auth';
import {
  createPiResourceLoader,
  getOrCreateReloadedExtensionLoader,
  type PiResourceLoaderOptions,
} from './resource-loader';
import {
  createArchonUIBridge,
  createArchonUIContext,
  type ArchonUIBridge,
} from './ui-context-stub';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type AgentSessionOptions = NonNullable<Parameters<PiSdk['createAgentSession']>[0]>;
type AgentSession = Awaited<ReturnType<PiSdk['createAgentSession']>>['session'];
type ModelRegistry = InstanceType<PiSdk['ModelRegistry']>;
type SettingsManager = ReturnType<PiSdk['SettingsManager']['inMemory']>;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

/**
 * Load user's Pi settings from disk (~/.pi/agent/settings.json for global,
 * <cwd>/.pi/settings.json for project) as the starting point, then seed an
 * in-memory instance. The in-memory instance guarantees no write-back to
 * the user's settings files — AgentSession setter calls (setModel, etc.)
 * write only to the in-process InMemorySettingsStorage object.
 *
 * NOTE: fileSettings is used only for the initial load; it is NOT passed to
 * DefaultResourceLoader or AgentSession. DefaultResourceLoader creates its own
 * file-backed SettingsManager internally for extension discovery. Sharing this
 * instance is unsafe: DefaultResourceLoader.reload() calls
 * settingsManager.reload(), which resets InMemorySettingsStorage to {} (the
 * storage's global/project fields are undefined after inMemory() construction,
 * so reload() produces empty settings, wiping all loaded user preferences).
 */
export function seedPiSettings(pi: PiSdk, cwd: string): SettingsManager {
  const fileSettings = pi.SettingsManager.create(cwd);

  // Drain and log any settings file parse errors (malformed JSON, etc.) — non-fatal.
  const settingsErrors = fileSettings.drainErrors();
  for (const { scope, error: err } of settingsErrors) {
    getLog().warn({ scope, err }, 'pi.settings_load_error');
  }

  // Pre-merge global + project settings before seeding inMemory().
  // NOTE: Using applyOverrides() after construction is unsafe due to Pi SDK internals:
  // SettingsManager.save() (dist/core/settings-manager.js) recalculates
  //   this.settings = deepMergeSettings(this.globalSettings, this.projectSettings)
  // wiping any applyOverrides() work, because inMemory() always constructs with
  // this.projectSettings = {}. save() is called by setDefaultModelAndProvider()
  // (dist/core/settings-manager.js), which AgentSession.setModel() calls
  // (dist/core/agent-session.js) whenever an extension switches models in an
  // interactive session — silently wiping project overrides mid-session.
  // deepMergeSettings is not exported from the Pi SDK; replicate its one-level-deep
  // semantics (nested objects merged one level deep, primitives/arrays override).
  const globalSettings = fileSettings.getGlobalSettings();
  const projectSettings = fileSettings.getProjectSettings();
  const seedSettings: Record<string, unknown> = { ...globalSettings };
  for (const key of Object.keys(projectSettings)) {
    const pv = (projectSettings as Record<string, unknown>)[key];
    if (pv === undefined) continue;
    const gv = seedSettings[key];
    seedSettings[key] =
      isPlainObject(pv) && isPlainObject(gv)
        ? { ...(gv as Record<string, unknown>), ...(pv as Record<string, unknown>) }
        : pv;
  }
  return pi.SettingsManager.inMemory(
    seedSettings as ReturnType<typeof fileSettings.getGlobalSettings>
  );
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A turn's ResourceLoader, and what its extensions contribute to the turn. */
export interface PiResources {
  resourceLoader: DefaultResourceLoader;
  /** Absolute paths of the loaded extensions, for attributing their errors. */
  extensionPaths: string[];
  /** Providers the loaded extensions registered on this turn's ModelRegistry. */
  extensionProviderNames: Set<string>;
}

/**
 * Build the ResourceLoader. When extensions are ON we MUST reuse a
 * process-cached, already-reloaded loader: Pi's `reload()` re-invokes every
 * installed extension factory from scratch and the 2nd reload in a process
 * deadlocks on the first call's never-torn-down state (issue #1877 — see the
 * doc on getOrCreateReloadedExtensionLoader). When extensions are OFF there
 * is no re-entrancy hazard, so a fresh per-call loader can reload safely.
 * That reload is still required for Pi to discover its native context files.
 * Both paths take the same options so they can't drift.
 */
export async function loadPiResources(
  cwd: string,
  loaderOptions: PiResourceLoaderOptions,
  enableExtensions: boolean,
  modelRegistry: ModelRegistry,
  signal: AbortSignal | undefined
): Promise<PiResources> {
  if (!enableExtensions) {
    const resourceLoader = createPiResourceLoader(cwd, loaderOptions);
    await resourceLoader.reload();
    return { resourceLoader, extensionPaths: [], extensionProviderNames: new Set() };
  }
  const { loader, providerRegistrations } = await getOrCreateReloadedExtensionLoader(
    cwd,
    loaderOptions,
    signal
  );
  const extensionPaths = loader
    .getExtensions()
    .extensions.flatMap(extension => [extension.path, extension.resolvedPath])
    .filter(isAbsolute);
  // Re-apply the load-time extension provider registrations to THIS call's
  // fresh ModelRegistry (issue #2064). Extension factories run only during
  // the single cached reload(), and the SDK drains their queued
  // registerProvider() calls into the FIRST session's registry only — so
  // without this, the 2nd+ sendQuery in a process (e.g. DAG node 2) never
  // sees extension models (pi-cursor's `cursor/*`) and LOOKUP-2 fails.
  // registerProvider() is a documented upsert, so the first call receiving
  // the same configs again via its own bindCore() flush is harmless.
  const extensionProviderNames = new Set<string>();
  for (const { name, config, extensionPath } of providerRegistrations) {
    extensionProviderNames.add(name);
    try {
      modelRegistry.registerProvider(name, config);
    } catch (err) {
      // Intentional non-fatal fallback mirroring the SDK's own bindCore()
      // flush (per-entry try/catch + emitted extension error): one broken
      // extension config must not fail nodes that use other providers.
      // If the model this node actually needs is missing, LOOKUP-2 below
      // still throws the loud, actionable "Pi model not found" error.
      getLog().warn(
        { err, piExtensionProvider: name, extensionPath },
        'pi.extension_provider_reapply_failed'
      );
    }
  }
  if (providerRegistrations.length > 0) {
    getLog().debug({ count: providerRegistrations.length }, 'pi.extension_providers_reapplied');
  }
  return { resourceLoader: loader, extensionPaths, extensionProviderNames };
}

/** Everything `openPiSession` builds the session from. */
export interface PiSessionRequest {
  cwd: string;
  parsed: PiModelRef;
  /** The static-catalog model; undefined when an extension provider must register it. */
  model: AgentSessionOptions['model'];
  modelRuntime: AgentSessionOptions['modelRuntime'];
  modelRegistry: ModelRegistry;
  sessionManager: AgentSessionOptions['sessionManager'];
  settingsManager: SettingsManager;
  resources: PiResources;
  thinkingLevel: AgentSessionOptions['thinkingLevel'];
  /** The tool payload; undefined keeps Pi's defaults (an unrestricted node). */
  customTools: AgentSessionOptions['customTools'];
  resumed: boolean;
  extensions: PiExtensionSettings;
  extensionTurn: PiExtensionTurn | undefined;
}

export interface OpenedPiSession {
  session: AgentSession;
  uiBridge: ArchonUIBridge | undefined;
}

/**
 * Create the session, then run what must happen before its first prompt: restore
 * fresh tools on a resumed unrestricted node, pass extension flags, bind extensions
 * (or fire session_start without UI), and resolve an extension provider's model.
 * Yields the model-fallback warning. Disposes the session when a later step throws.
 */
export async function* openPiSession(
  pi: PiSdk,
  request: PiSessionRequest
): AsyncGenerator<MessageChunk, OpenedPiSession> {
  const { session, modelFallbackMessage } = await pi.createAgentSession({
    cwd: request.cwd,
    // model is omitted when not yet resolved (extension provider path).
    // createAgentSession accepts this — the model will be set via
    // session.setModel() after bindExtensions() resolves it (LOOKUP-2).
    ...(request.model ? { model: request.model } : {}),
    // pi 0.84.0+: createAgentSession no longer accepts authStorage +
    // modelRegistry separately; pass the modelRuntime and the SDK builds its
    // own internal registry facade. The runtime we pass is the one already
    // scoped with `setRuntimeApiKey` calls, and for custom providers
    // it was built against a per-call `modelsPath` with `${VAR}` references
    // pre-substituted (see ./auth.ts) — no further per-call wiring.
    modelRuntime: request.modelRuntime,
    sessionManager: request.sessionManager,
    settingsManager: request.settingsManager,
    resourceLoader: request.resources.resourceLoader,
    ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
    // Pi 0.68+: `tools` was repurposed as a string[] allowlist of built-in
    // tool names; the actual Tool[] payload now goes through `customTools`.
    // `noTools: "builtin"` suppresses the default built-in set so our
    // filtered (and env-injected bash) list isn't doubled up (the
    // suppression-behavior bug was fixed in pi 0.70.0). When customTools
    // is undefined (an unrestricted node) we keep Pi's defaults.
    //
    // `customTools` is also the only path through which we can attach a
    // BashSpawnHook for managed-env injection: Pi's built-in bash tool is
    // pre-constructed without a spawnHook (see resolvePiTools in
    // options-translator.ts), so the env-aware bash MUST go through
    // customTools, not just for tool restriction.
    ...(request.customTools !== undefined
      ? { customTools: request.customTools, noTools: 'builtin' as const }
      : {}),
  });

  // Given neither `tools` nor `noTools`, Pi 1.3+ restores a reopened
  // session's tools from its transcript, so an unrestricted node would
  // inherit the restriction of the node that wrote the session.
  if (request.resumed && request.customTools === undefined) {
    session.setActiveToolsByName(
      freshPiToolNames(session, request.settingsManager.getDefaultTools())
    );
  }

  // Extension models aren't in the static catalog — skip the fallback warning.
  if (modelFallbackMessage && request.model) {
    yield { type: 'warning', code: 'pi.model_fallback', message: modelFallbackMessage };
  }

  passExtensionFlags(session, request.extensions);
  const uiBridge = await bindPiExtensions(session, request.extensions, request.extensionTurn);
  if (!request.model) await setExtensionModel(session, request);
  return { session, uiBridge };
}

/**
 * Extension flag pass-through. Must happen before bindExtensions — extensions read
 * flags inside their session_start handler. `extensionFlags` is the per-node resolved
 * map (assistant-level flags shallow-merged with `nodes.<nodeId>.extensionFlags`, node
 * wins).
 */
function passExtensionFlags(session: AgentSession, extensions: PiExtensionSettings): void {
  if (!extensions.enableExtensions || !extensions.extensionFlags) return;
  const runner = session.extensionRunner;
  if (!runner) return;
  for (const [name, value] of Object.entries(extensions.extensionFlags)) {
    runner.setFlagValue(name, value);
  }
}

/**
 * Bind UI context or fire session_start with no UI. Must run after flag pass-through.
 * Extension providers register their models during bindExtensions() — this is the
 * trigger for LOOKUP-2: they call registerProvider() on our modelRegistry during
 * session_start.
 */
async function bindPiExtensions(
  session: AgentSession,
  extensions: PiExtensionSettings,
  extensionTurn: PiExtensionTurn | undefined
): Promise<ArchonUIBridge | undefined> {
  const uiBridge = extensions.interactive ? createArchonUIBridge() : undefined;
  const onExtensionError = extensionTurn
    ? (error: ExtensionError): void => {
        extensionTurn.reportStructured(error);
      }
    : undefined;
  try {
    if (uiBridge) {
      const uiContext = createArchonUIContext(uiBridge);
      await session.bindExtensions({ uiContext, onError: onExtensionError });
    } else if (extensions.enableExtensions) {
      await session.bindExtensions({ onError: onExtensionError });
    }
    extensionTurn?.throwIfFailed();
  } catch (error) {
    session.dispose();
    throw error;
  }
  return uiBridge;
}

/**
 * [LOOKUP-2] Re-check the registry after bindExtensions() for extension-registered
 * models. Safe to call session.setModel() here — no prompt has been sent yet.
 */
async function setExtensionModel(session: AgentSession, request: PiSessionRequest): Promise<void> {
  const { parsed, modelRegistry } = request;
  const model = modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model) {
    session.dispose();
    throw modelNotFoundError(
      parsed,
      request.resources.extensionProviderNames.has(parsed.provider),
      modelRegistry
    );
  }
  try {
    await session.setModel(model);
    request.extensionTurn?.throwIfFailed();
  } catch (err) {
    session.dispose();
    throw err;
  }
}

function modelNotFoundError(
  parsed: PiModelRef,
  extensionProvider: boolean,
  modelRegistry: ModelRegistry
): ClassifiedProviderError {
  const catalogProvider =
    !extensionProvider && modelRegistry.getProvider(parsed.provider) !== undefined;
  const remedy = catalogProvider
    ? 'The provider is configured, but this model id is not in the Pi model catalog. ' +
      'If the model is newer than your catalog, refresh it with `pi update --models`; ' +
      `Archon reads the refreshed store at ${getUserModelsStorePath()}.`
    : extensionProvider
      ? `Provider '${parsed.provider}' comes from an installed Pi extension, but that ` +
        'extension did not register this model id. Check the extension configuration and model name.'
      : `Provider '${parsed.provider}' is not in the Pi model catalog. If it comes from a Pi ` +
        'provider extension, install that extension (e.g. `pi install npm:pi-provider-kiro`) ' +
        'and set `enableExtensions: true` in .archon/config.yaml. If it is a catalog provider, ' +
        'refresh the catalog with `pi update --models`.';
  return new ClassifiedProviderError(
    'misconfigured',
    `Pi model not found: provider='${parsed.provider}' model='${parsed.modelId}'. ${remedy}`
  );
}
