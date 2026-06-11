import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@archon/paths';
// Type-only import — erased by TS, so it does NOT trigger Pi's config.js
// package.json read at module load (see the header note below). Used only to
// annotate the per-call ResourceLoader local.
import type { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { PI_CAPABILITIES } from './capabilities';
import { parsePiConfig } from './config';
import { parsePiModelRef } from './model-ref';

// IMPORTANT: Do NOT add static `import { ... } from '@earendil-works/*'` here,
// and do NOT statically import sibling modules that themselves import runtime
// values from Pi (options-translator, resource-loader, session-resolver,
// ui-context-stub, event-bridge). Pi's `@earendil-works/pi-coding-agent/dist/config.js`
// runs `readFileSync(getPackageJsonPath(), "utf-8")` at module load; inside a
// compiled Archon binary `getPackageJsonPath()` resolves to
// `dirname(process.execPath) + "/package.json"` — a path that doesn't exist —
// and archon crashes at startup before any command runs (v0.3.7 symptom).
//
// All Pi SDK value bindings and Pi-dependent helper modules are dynamically
// imported inside `sendQuery()` below, which runs only when a Pi workflow is
// actually invoked. Type-only imports above are fine — TS erases them.
//
// Lazy-loading defers the crash from boot-time to sendQuery-time — but the
// crash still happens when Pi is actually used. `ensurePiPackageDirShim()`
// (see below) fixes the *runtime* half: before any dynamic Pi import in
// sendQuery, write a stub package.json to tmpdir and point Pi at it via
// its own documented `PI_PACKAGE_DIR` escape hatch.

// ─── Concurrency throttle ────────────────────────────────────────────────────

/**
 * Simple counting semaphore for capping concurrent Pi `session.prompt()` calls.
 * Pi/Minimax has no built-in SDK-level throttling; without this, large parallel
 * workflow batches (e.g. 10+ concurrent review PRs × 5 aspects each) hit rate
 * limits and cascade-fail. Module-level so it's shared across all PiProvider
 * instances within a process — Pi concurrency is global (one upstream backend).
 */
class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(count: number) {
    this.available = count;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available++;
  }
}

let piSemaphore: Semaphore | undefined;

/**
 * Write a minimal package.json to a stable tmpdir and set `PI_PACKAGE_DIR`
 * so Pi's `config.js` short-circuits its `dirname(process.execPath)` walk
 * (which fails inside a compiled archon binary). Pi only reads three
 * optional fields from that package.json — `piConfig.name`, `piConfig.configDir`,
 * and `version` — so the stub is genuinely minimal. Idempotent: the file is
 * only written once per host (existsSync check), and the env var is set on
 * every call so multiple PiProvider instances stay consistent.
 *
 * Done on each sendQuery rather than at module load so (a) the file write
 * is paid only when Pi is actually used, and (b) the env var can't get
 * clobbered between registration and invocation.
 */
export function ensurePiPackageDirShim(): void {
  const shimDir = join(tmpdir(), 'archon-pi-shim');
  const shimPkgJson = join(shimDir, 'package.json');
  if (!existsSync(shimPkgJson)) {
    // `piConfig: {}` is explicit so Pi's defaults (`name: 'pi'`,
    // `configDir: '.pi'`) kick in — matches Pi's standalone behavior.
    try {
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(
        shimPkgJson,
        JSON.stringify({
          name: 'archon-pi-shim',
          version: '0.0.0',
          piConfig: {},
        })
      );
    } catch (error) {
      // Surface as a classified error so the executor's catch sees a known
      // shape instead of a raw EACCES/ENOSPC from node:fs.
      const err = error as NodeJS.ErrnoException;
      throw new Error(`Pi shim setup failed at ${shimDir}: ${err.message}`);
    }
  }
  process.env.PI_PACKAGE_DIR = shimDir;
}

// Pi provider id → env var name used by pi-ai's getEnvApiKey(). Generated
// from the installed pi-ai SDK (full backend coverage) — see
// scripts/generate-pi-vendor-map.ts; `bun run check:pi-vendor-map` guards drift.
import { PI_PROVIDER_ENV_VARS } from './pi-vendor-map.generated';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

// Structured-output prompt augmentation is shared across providers. Import
// once for local use and re-export so existing callers and tests keep their
// import path stable; new providers should import from `../../shared/structured-output`.
import { augmentPromptForJsonSchema } from '../../shared/structured-output';
export { augmentPromptForJsonSchema };

/**
 * Pi community provider — wraps `@earendil-works/pi-coding-agent`'s full
 * coding-agent harness. Each `sendQuery()` call creates a fresh session
 * (no reuse) so concurrent calls don't collide.
 */
export class PiProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    // Install the PI_PACKAGE_DIR shim BEFORE the dynamic imports below: Pi's
    // config.js runs `readFileSync(getPackageJsonPath())` at its own module
    // init, and getPackageJsonPath() checks process.env.PI_PACKAGE_DIR first.
    // Without this, the dynamic import below would crash with ENOENT on
    // `dirname(process.execPath)/package.json` inside a compiled binary.
    ensurePiPackageDirShim();

    // Lazy-load Pi SDK and all Pi-dependent helper modules here. Must not move
    // these imports to module scope — see the header comment for the failure
    // mode (archon compiled binary crashes at startup when Pi's config.js
    // reads a package.json that doesn't exist next to the executable).
    //
    // Class constructors (AuthStorage, ModelRegistry, SettingsManager) are
    // accessed via `piCodingAgent.X` rather than destructured, because
    // destructured PascalCase bindings trip eslint's naming-convention rule.
    const [
      piCodingAgent,
      { bridgeSession },
      { resolvePiSkills, resolvePiThinkingLevel, resolvePiTools, buildDefaultPiTools },
      { createNoopResourceLoader, getOrCreateReloadedExtensionLoader },
      { resolvePiSession },
      { createArchonUIBridge, createArchonUIContext },
      { buildPiNativeToolDefinitions },
    ] = await Promise.all([
      import('@earendil-works/pi-coding-agent'),
      import('./event-bridge'),
      import('./options-translator'),
      import('./resource-loader'),
      import('./session-resolver'),
      import('./ui-context-stub'),
      import('./native-tools'),
    ]);
    const { createAgentSession } = piCodingAgent;

    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const piConfig = parsePiConfig(assistantConfig);

    // 0. Apply config-level env vars to process.env for in-process extensions
    //    (plannotator reads PLANNOTATOR_REMOTE at session_start, etc.).
    //    Shell env wins: we only set keys not already present. Request-level
    //    `requestOptions.env` remains a separate channel — it flows through
    //    bash spawn hooks for subprocess isolation, not into process.env.
    if (piConfig.env) {
      const applied: string[] = [];
      for (const [key, value] of Object.entries(piConfig.env)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
          applied.push(key);
        }
      }
      if (applied.length > 0) {
        getLog().debug({ keys: applied }, 'pi.config_env_applied');
      }
    }

    // 1. Resolve model ref: request (workflow node / chat) → config default
    const modelRef = requestOptions?.model ?? piConfig.model;
    if (!modelRef) {
      throw new Error(
        'Pi provider requires a model. Set `model` on the workflow node or `assistants.pi.model` in .archon/config.yaml. ' +
          "Format: '<pi-provider-id>/<model-id>' (e.g. 'google/gemini-2.5-pro')."
      );
    }
    const parsed = parsePiModelRef(modelRef);
    if (!parsed) {
      throw new Error(
        `Invalid Pi model ref: '${modelRef}'. Expected format '<pi-provider-id>/<model-id>' (e.g. 'google/gemini-2.5-pro').`
      );
    }

    // 2. Build AuthStorage + ModelRegistry. Both read on every sendQuery —
    //    user edits to auth.json or models.json take effect without restart.
    //    ModelRegistry.create() is mutable: extension providers can call registerProvider()
    //    on it during bindExtensions() to add their models (phase 2 resolution).
    let authStorage: ReturnType<typeof piCodingAgent.AuthStorage.create>;
    let modelRegistry: ReturnType<typeof piCodingAgent.ModelRegistry.create>;
    try {
      // Archon delivers per-user credentials (API keys + subscriptions) as a
      // per-run auth.json and points us at it via ARCHON_PI_AUTH_PATH — using an
      // explicit authPath (not PI_CODING_AGENT_DIR) so the user's models.json /
      // settings.json at ~/.pi/agent/ are untouched. The path arrives on the
      // per-call `requestOptions.env` channel (the executor's per-user injection
      // never writes to process.env — see the piConfig.env note above), so read it
      // there first and fall back to process.env for a shell-level override.
      const archonAuthPath =
        (requestOptions?.env?.ARCHON_PI_AUTH_PATH ?? process.env.ARCHON_PI_AUTH_PATH)?.trim() ||
        undefined;
      authStorage = piCodingAgent.AuthStorage.create(archonAuthPath);
      modelRegistry = piCodingAgent.ModelRegistry.create(authStorage);
    } catch (err) {
      const e = err as Error;
      getLog().error({ err: e, piProvider: parsed.provider }, 'pi.auth_storage_init_failed');
      throw new Error(
        `Pi auth storage init failed: ${e.message}. Check that ~/.pi/agent/auth.json ` +
          '(or $PI_CODING_AGENT_DIR/auth.json) is valid JSON and readable.'
      );
    }

    // 3. [LOOKUP-1] Check the static catalog first (phase 1 of 2).
    //    Extension providers (e.g. kiro) aren't in the catalog — defer to LOOKUP-2 after bindExtensions().
    let model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) {
      // Surface any models.json load error as a warning — helps debug
      // custom-provider configs (e.g. missing baseUrl in models.json).
      const loadError = modelRegistry.getError?.();
      if (loadError) {
        getLog().warn(
          { piProvider: parsed.provider, modelId: parsed.modelId, loadError },
          'pi.model_registry_load_error'
        );
      }
      // Not an error yet — extension providers will register during
      // bindExtensions(). Log at info so the deferral is visible in logs.
      getLog().info(
        { piProvider: parsed.provider, modelId: parsed.modelId },
        'pi.model_not_in_static_catalog_deferring'
      );
    }

    // 4. Resolve credentials. Per-request env vars override auth.json entries via
    //    setRuntimeApiKey — codebase-scoped env vars win over the user's global Pi login.
    const envVarName = PI_PROVIDER_ENV_VARS[parsed.provider];
    const envOverride = envVarName
      ? (requestOptions?.env?.[envVarName] ?? process.env[envVarName])
      : undefined;
    if (envOverride) {
      authStorage.setRuntimeApiKey(parsed.provider, envOverride);
    }

    // Auth validation deferred for extension providers — they manage credentials
    // outside Pi's AuthStorage (e.g. kiro uses AWS SSO/OIDC via ~/.aws/sso/cache/).
    // Only validate early for static-catalog models where we can give actionable hints.
    if (model) {
      const resolvedKey = await authStorage.getApiKey(parsed.provider);
      if (!resolvedKey) {
        if (envVarName) {
          const envHint = `Set ${envVarName} in the environment or codebase env vars (.archon/config.yaml env: section).`;
          const loginHint = `Or run \`pi\` and type \`/login\` locally to authenticate '${parsed.provider}' via OAuth; credentials land in ~/.pi/agent/auth.json and are picked up automatically.`;
          throw new Error(
            `Pi auth: no credentials for provider '${parsed.provider}'. ${envHint} ${loginHint}`
          );
        }

        // Unmapped providers (LM Studio, ollama, llamacpp, custom
        // OpenAI-compatible endpoints) often don't need credentials at all —
        // log + continue rather than failing fast so local models work without
        // ceremony. If the SDK call later fails for a provider that *does*
        // need creds, the auth_missing breadcrumb is searchable in the log.
        getLog().info(
          {
            piProvider: parsed.provider,
            envHint: `Provider '${parsed.provider}' is not in the Archon adapter's env-var table — file an issue if you want a shortcut env var for it.`,
            loginHint: `Or run \`pi\` and type \`/login\` locally to authenticate '${parsed.provider}' via OAuth; credentials land in ~/.pi/agent/auth.json and are picked up automatically.`,
          },
          'pi.auth_missing'
        );
      }
    }

    // 4. Translate Archon nodeConfig to Pi SDK options. All three translations
    //    below correspond to capability flags declared `true` in
    //    PI_CAPABILITIES; nodeConfig fields that don't map cleanly still
    //    trigger a dag-executor warning upstream.
    const nodeConfig = requestOptions?.nodeConfig;

    //    4a. thinkingLevel: covers `thinking`/`effort` nodeConfig fields.
    const { level: thinkingLevel, warning: thinkingWarning } = resolvePiThinkingLevel(nodeConfig);
    if (thinkingWarning) {
      yield { type: 'system', content: `⚠️ ${thinkingWarning}` };
    }

    //    4b. tools: covers allowed_tools / denied_tools. `undefined` leaves Pi
    //        defaults; an explicit empty array means "no tools" (valid idiom
    //        matching e2e-claude-smoke's `allowed_tools: []`).
    //        requestOptions.env (codebase-scoped env vars from .archon/config.yaml)
    //        is injected into bash subprocesses via a BashSpawnHook, mirroring
    //        Claude's options.env and Codex's constructor env.
    const { tools: filteredTools, unknownTools } = resolvePiTools(
      cwd,
      nodeConfig,
      requestOptions?.env
    );
    if (unknownTools.length > 0) {
      yield {
        type: 'system',
        content: `⚠️ Pi ignored unknown tool names: ${unknownTools.join(', ')}. Pi's built-in tools: read, bash, edit, write, grep, find, ls.`,
      };
    }

    //    4c. systemPrompt: request-level (AgentRequestOptions) wins over
    //        node-level; either overrides Pi's default.
    //        Pi only supports string system prompts; ignore structured preset objects.
    const rawSystemPrompt = requestOptions?.systemPrompt ?? nodeConfig?.systemPrompt;
    const systemPrompt = typeof rawSystemPrompt === 'string' ? rawSystemPrompt : undefined;
    if (rawSystemPrompt !== undefined && systemPrompt === undefined) {
      getLog().warn(
        { systemPromptType: typeof rawSystemPrompt },
        'pi.system_prompt_dropped_non_string'
      );
    }

    //    4d. skills: Archon uses name references (e.g. `skills: [agent-browser]`).
    //        Resolve each name against .agents/skills and .claude/skills (project
    //        + user-global). Resolved paths go through Pi's additionalSkillPaths;
    //        Pi's buildSystemPrompt appends their agentskills.io XML block to
    //        the system prompt automatically, so the model sees them.
    const { paths: skillPaths, missing: missingSkills } = resolvePiSkills(cwd, nodeConfig?.skills);
    if (missingSkills.length > 0) {
      yield {
        type: 'system',
        content: `⚠️ Pi could not resolve skill names: ${missingSkills.join(', ')}. Searched .agents/skills and .claude/skills (project + user-global). Each must be a directory containing SKILL.md.`,
      };
    }

    // 5. Session management. Pi stores each session as a JSONL file under
    //    ~/.pi/agent/sessions/<encoded-cwd>/<uuid>.jsonl. `resolvePiSession`
    //    returns a SessionManager bound to either a new session (no resume
    //    id) or an existing session (resume id matches a file); if the id
    //    was provided but not found, it falls through to a new session and
    //    the caller surfaces a resume_failed warning (matches the Codex
    //    provider's fallback pattern for the same condition).
    const { sessionManager, resumeFailed } = await resolvePiSession(cwd, resumeSessionId);
    if (resumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume Pi session. Starting fresh conversation.',
      };
    }

    // Load user's Pi settings from disk (~/.pi/agent/settings.json for global,
    // <cwd>/.pi/settings.json for project) as the starting point, then seed an
    // in-memory instance. The in-memory instance guarantees no write-back to
    // the user's settings files — AgentSession setter calls (setModel, etc.)
    // write only to the in-process InMemorySettingsStorage object.
    //
    // NOTE: fileSettings is used only for the initial load; it is NOT passed to
    // DefaultResourceLoader or AgentSession. DefaultResourceLoader creates its own
    // file-backed SettingsManager internally for extension discovery. Sharing this
    // instance is unsafe: DefaultResourceLoader.reload() calls
    // settingsManager.reload(), which resets InMemorySettingsStorage to {} (the
    // storage's global/project fields are undefined after inMemory() construction,
    // so reload() produces empty settings, wiping all loaded user preferences).
    const fileSettings = piCodingAgent.SettingsManager.create(cwd);

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
        typeof pv === 'object' &&
        pv !== null &&
        !Array.isArray(pv) &&
        typeof gv === 'object' &&
        gv !== null &&
        !Array.isArray(gv)
          ? { ...(gv as Record<string, unknown>), ...(pv as Record<string, unknown>) }
          : pv;
    }
    const settingsManager = piCodingAgent.SettingsManager.inMemory(
      seedSettings as ReturnType<typeof fileSettings.getGlobalSettings>
    );
    // Default ON: extensions (community packages like @plannotator/pi-extension
    // or your own local ones) are a core reason users run Pi. Opt out with
    // `assistants.pi.enableExtensions: false` (or `interactive: false`) in
    // `.archon/config.yaml`. Previously default-off, which silently broke
    // users who installed or built an extension and expected it to fire.
    const enableExtensions = piConfig.enableExtensions !== false;
    // Clamp to false without extensions: nothing consumes hasUI without a runner.
    const interactive = enableExtensions && piConfig.interactive !== false;

    // Build the ResourceLoader. When extensions are ON we MUST reuse a
    // process-cached, already-reloaded loader: Pi's `reload()` re-invokes every
    // installed extension factory from scratch and the 2nd reload in a process
    // deadlocks on the first call's never-torn-down state (issue #1877 — see the
    // doc on getOrCreateReloadedExtensionLoader). When extensions are OFF there
    // is no reload() and thus no re-entrancy hazard, so a fresh per-call loader
    // is fine. Build the shared options once so the two paths can't drift.
    const loaderOptions = {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
    };
    const resourceLoader: DefaultResourceLoader = enableExtensions
      ? await getOrCreateReloadedExtensionLoader(cwd, loaderOptions)
      : createNoopResourceLoader(cwd, loaderOptions);

    getLog().info(
      {
        piProvider: parsed.provider,
        modelId: parsed.modelId,
        cwd,
        thinkingLevel,
        toolCount: filteredTools?.length,
        hasSystemPrompt: systemPrompt !== undefined,
        skillCount: skillPaths.length,
        missingSkillCount: missingSkills.length,
        extensionsEnabled: enableExtensions,
        interactive,
        resumed: resumeSessionId !== undefined && !resumeFailed,
      },
      'pi.session_started'
    );

    // In-process native tools (e.g. manage_run) via Pi customTools. Because
    // setting customTools forces noTools:'builtin' (dropping Pi's defaults), the
    // base tool set must be re-supplied alongside the native defs.
    const nativeToolDefs =
      requestOptions?.nativeTools && requestOptions.nativeTools.length > 0
        ? buildPiNativeToolDefinitions(requestOptions.nativeTools)
        : [];
    const baseTools =
      filteredTools ??
      (nativeToolDefs.length > 0 ? buildDefaultPiTools(cwd, requestOptions?.env) : undefined);
    const piCustomTools =
      nativeToolDefs.length > 0 ? [...(baseTools ?? []), ...nativeToolDefs] : filteredTools;

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd,
      // model is omitted when not yet resolved (extension provider path).
      // createAgentSession accepts this — the model will be set via
      // session.setModel() after bindExtensions() resolves it (step 4g).
      ...(model ? { model } : {}),
      authStorage,
      modelRegistry,
      sessionManager,
      settingsManager,
      resourceLoader,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // Pi 0.68+: `tools` was repurposed as a string[] allowlist of built-in
      // tool names; the actual Tool[] payload now goes through `customTools`.
      // `noTools: "builtin"` suppresses the default built-in set so our
      // filtered (and env-injected bash) list isn't doubled up (the
      // suppression-behavior bug was fixed in pi 0.70.0). When filteredTools
      // is undefined we keep Pi's defaults — no overrides.
      //
      // `customTools` is also the only path through which we can attach a
      // BashSpawnHook for managed-env injection: Pi's built-in bash tool is
      // pre-constructed without a spawnHook (see resolvePiTools in
      // options-translator.ts), so the env-aware bash MUST go through
      // customTools, not just for tool restriction.
      ...(piCustomTools !== undefined
        ? { customTools: piCustomTools, noTools: 'builtin' as const }
        : {}),
    });

    // Extension models aren't in the static catalog — skip the fallback warning.
    if (modelFallbackMessage && model) {
      yield { type: 'system', content: `⚠️ ${modelFallbackMessage}` };
    }

    // 4e. Extension flag pass-through. Must happen before bindExtensions
    //     below — extensions read flags inside their session_start handler.
    if (enableExtensions && piConfig.extensionFlags) {
      const runner = session.extensionRunner;
      if (runner) {
        for (const [name, value] of Object.entries(piConfig.extensionFlags)) {
          runner.setFlagValue(name, value);
        }
      }
    }

    // 4f. Bind UI context or fire session_start with no UI. Must run after flag pass-through above.
    //     Extension providers register their models during bindExtensions() — this is the trigger
    //     for LOOKUP-2: they call registerProvider() on our modelRegistry during session_start.
    const uiBridge = interactive ? createArchonUIBridge() : undefined;
    if (uiBridge) {
      const uiContext = createArchonUIContext(uiBridge);
      await session.bindExtensions({ uiContext });
    } else if (enableExtensions) {
      await session.bindExtensions({});
    }

    // 4g. [LOOKUP-2] Re-check the registry after bindExtensions() for extension-registered models.
    //     Safe to call session.setModel() here — no prompt has been sent yet.
    if (!model) {
      model = modelRegistry.find(parsed.provider, parsed.modelId);
      if (!model) {
        session.dispose();
        throw new Error(
          `Pi model not found: provider='${parsed.provider}' model='${parsed.modelId}'. ` +
            'The model was not found in the static catalog or via any installed extension. ' +
            'Ensure the provider extension is installed (e.g. `pi install npm:pi-provider-kiro`) ' +
            'and `enableExtensions: true` is set in .archon/config.yaml.'
        );
      }
      try {
        await session.setModel(model);
      } catch (err) {
        session.dispose();
        throw err;
      }
    }

    // 5. Structured output (best-effort). Pi has no SDK-level JSON schema
    //    mode the way Claude and Codex do, so we implement it via prompt
    //    engineering: append the schema + "JSON only, no fences" instruction,
    //    and have the bridge parse the accumulated assistant text on
    //    agent_end. Parse failures degrade gracefully — the executor's
    //    existing dag.structured_output_missing warning path handles them.
    const outputFormat = requestOptions?.outputFormat;
    const effectivePrompt = outputFormat
      ? augmentPromptForJsonSchema(prompt, outputFormat.schema)
      : prompt;

    // 6. Bridge callback-based events to the async generator contract.
    //    bridgeSession owns dispose() and abort wiring. When `interactive`
    //    is on, it also binds/unbinds the UI stub's emitter so extension
    //    notifications land on the same queue as Pi events.
    //
    //    The module-level semaphore is initialized lazily from the first
    //    config that sets maxConcurrent and reused for the lifetime of the
    //    process — this is a known v1 tradeoff. Pi concurrency is global
    //    (one upstream backend) so a process-wide cap is the right scope.
    const maxConcurrent = piConfig.maxConcurrent;
    if (maxConcurrent !== undefined && piSemaphore === undefined) {
      piSemaphore = new Semaphore(maxConcurrent);
      getLog().info({ maxConcurrent }, 'pi.semaphore_initialized');
    }

    // Snapshot before the first await — if a concurrent call initializes the
    // module-level piSemaphore after this point, sem stays undefined and the
    // finally block correctly skips release (we never acquired).
    const sem = piSemaphore;
    if (sem !== undefined) {
      getLog().debug('pi.semaphore_acquiring');
      await sem.acquire();
      getLog().debug('pi.semaphore_acquired');
    }
    try {
      yield* bridgeSession(
        session,
        effectivePrompt,
        requestOptions?.abortSignal,
        outputFormat?.schema,
        uiBridge
      );
      getLog().info({ piProvider: parsed.provider }, 'pi.prompt_completed');
    } catch (err) {
      getLog().error({ err, piProvider: parsed.provider }, 'pi.prompt_failed');
      throw err;
    } finally {
      sem?.release();
    }
  }

  getType(): string {
    return 'pi';
  }

  getCapabilities(): ProviderCapabilities {
    return PI_CAPABILITIES;
  }
}
