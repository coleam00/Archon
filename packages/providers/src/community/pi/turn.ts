/**
 * One Pi turn as a stream: load the Pi SDK, resolve the model and credential,
 * translate the node's config, open the session and bridge its prompt's events.
 *
 * Only type imports from the Pi SDK and from Pi-dependent siblings; their values
 * are loaded inside `streamPiTurn` (see the lazy-load note in ./provider.ts).
 */
import { createLogger } from '@archon/paths';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MessageChunk, SendQueryOptions, SystemPromptInput } from '../../types';
import { resumedOutcome, withResumedOutcome } from '../../shared/resumed';
import { authorizePiTurn, openTurnModelRuntime, piAuthEnv, resolvePiModel } from './auth';
import { parsePiConfig, resolvePiExtensionSettings, type PiProviderDefaults } from './config';
import { beginPiExtensionTurn } from './extension-error-broker';
import type { PiModelRef } from './model-ref';
import type { RequestModelRuntime } from './request-auth';
import { Semaphore } from './semaphore';
import {
  ensureBedrockProviderRegistered,
  ensurePiOAuthFlowsRegistered,
  ensurePiPackageDirShim,
} from './sdk-setup';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

// ─── Concurrency throttle ────────────────────────────────────────────────────

/**
 * Caps concurrent Pi `session.prompt()` calls. Pi/Minimax has no built-in
 * SDK-level throttling; without this, large parallel workflow batches (e.g. 10+
 * concurrent review PRs × 5 aspects each) hit rate limits and cascade-fail.
 * Module-level so it's shared across all PiProvider instances within a process —
 * Pi concurrency is global (one upstream backend).
 */
let piSemaphore: Semaphore | undefined;

/** The Pi SDK and the Pi-dependent sibling modules a turn loads on demand. */
type PiTurnModules = Awaited<ReturnType<typeof loadPiTurnModules>>;

/**
 * Lazy-load Pi SDK and all Pi-dependent helper modules here. Must not move
 * these imports to module scope — see the header comment in ./provider.ts for
 * the failure mode (archon compiled binary crashes at startup when Pi's
 * config.js reads a package.json that doesn't exist next to the executable).
 *
 * Class constructors (AuthStorage, ModelRegistry, SettingsManager) are
 * accessed via `pi.X` rather than destructured.
 */
async function loadPiTurnModules() {
  // Install the PI_PACKAGE_DIR shim BEFORE the dynamic imports below: Pi's
  // config.js runs `readFileSync(getPackageJsonPath())` at its own module
  // init, and getPackageJsonPath() checks process.env.PI_PACKAGE_DIR first.
  // Without this, the dynamic import below would crash with ENOENT on
  // `dirname(process.execPath)/package.json` inside a compiled binary.
  ensurePiPackageDirShim();

  // Register Pi's Bedrock backend override (issue #2154) and subscription OAuth
  // flow loaders once per process so `amazon-bedrock/*` models and
  // `type: "oauth"` credentials work inside a compiled Archon binary. Kicked
  // off here to run concurrently with the SDK imports below; awaited before the
  // session streams (both are consulted lazily, when the backend loads or the
  // credential is first resolved).
  const bedrockReady = ensureBedrockProviderRegistered();
  const oauthFlowsReady = ensurePiOAuthFlowsRegistered();

  const [
    pi,
    eventBridge,
    optionsTranslator,
    sessionResolver,
    sessionSetup,
    nativeTools,
    structuredOutputTool,
  ] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('./event-bridge'),
    import('./options-translator'),
    import('./session-resolver'),
    import('./session-setup'),
    import('./native-tools'),
    import('./structured-output-tool'),
  ]);

  // Ensure both registrations are in place before any session work — the SDK
  // reads them only when a backend is first streamed or an OAuth credential is
  // first resolved, but awaiting here keeps the ordering obvious and the cost is
  // one resolved-promise await after the first call.
  await Promise.all([bedrockReady, oauthFlowsReady]);
  return {
    pi,
    eventBridge,
    optionsTranslator,
    sessionResolver,
    sessionSetup,
    nativeTools,
    structuredOutputTool,
  };
}

/** One Pi prompt as a stream of chunks; ./provider.ts owns the failure result and `settled`. */
export async function* streamPiTurn(
  prompt: string,
  cwd: string,
  resumeSessionId: string | undefined,
  requestOptions: SendQueryOptions | undefined
): AsyncGenerator<MessageChunk> {
  const modules = await loadPiTurnModules();
  const piConfig = parsePiConfig(requestOptions?.assistantConfig ?? {});
  applyConfigEnv(piConfig.env);

  const parsed = resolvePiModel(requestOptions?.model ?? piConfig.model, cwd, modules.pi);
  const authEnv = piAuthEnv(
    piConfig.env,
    requestOptions?.env,
    requestOptions?.protectedEnvKeys,
    requestOptions?.userCredentialEnvKeys
  );
  const requestModelRuntime = await openTurnModelRuntime(modules.pi, parsed.provider, authEnv);

  // Everything below uses the runtime, so this `finally` runs on every exit:
  // completion, a setup or lookup throw, and a consumer that stops reading.
  try {
    const modelRegistry = new modules.pi.ModelRegistry(requestModelRuntime.runtime);
    const model = findCatalogModel(modelRegistry, parsed);
    await authorizePiTurn(
      requestModelRuntime,
      parsed.provider,
      model !== undefined,
      authEnv,
      requestOptions?.abortSignal
    );
    yield* streamSession(modules, {
      prompt,
      cwd,
      resumeSessionId,
      requestOptions,
      piConfig,
      parsed,
      model,
      modelRuntime: requestModelRuntime.runtime,
      modelRegistry,
    });
  } finally {
    // The per-call models.json holds the substituted secret in cleartext.
    try {
      requestModelRuntime.release();
    } catch (err) {
      getLog().warn({ err, piProvider: parsed.provider }, 'pi.per_call_models_cleanup_failed');
    }
  }
}

/**
 * Apply config-level env vars to process.env for in-process extensions
 * (plannotator reads PLANNOTATOR_REMOTE at session_start, etc.).
 * Shell env wins: we only set keys not already present. Request-level
 * `requestOptions.env` remains a separate channel — it flows through
 * bash spawn hooks for subprocess isolation, not into process.env.
 */
function applyConfigEnv(configEnv: PiProviderDefaults['env']): void {
  if (!configEnv) return;
  const applied: string[] = [];
  for (const [key, value] of Object.entries(configEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  if (applied.length > 0) {
    getLog().debug({ keys: applied }, 'pi.config_env_applied');
  }
}

type ModelRegistry = InstanceType<PiTurnModules['pi']['ModelRegistry']>;
type CatalogModel = ReturnType<ModelRegistry['find']>;

/**
 * [LOOKUP-1] Check the static catalog first (phase 1 of 2). Extension providers
 * (e.g. kiro) aren't in the catalog — ./session-setup.ts looks again (LOOKUP-2)
 * after bindExtensions().
 */
function findCatalogModel(modelRegistry: ModelRegistry, parsed: PiModelRef): CatalogModel {
  const model = modelRegistry.find(parsed.provider, parsed.modelId);
  if (model) return model;
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
  return undefined;
}

/** The turn's inputs once its model and credential are settled. */
interface AuthorizedTurn {
  prompt: string;
  cwd: string;
  resumeSessionId: string | undefined;
  requestOptions: SendQueryOptions | undefined;
  piConfig: PiProviderDefaults;
  parsed: PiModelRef;
  model: CatalogModel;
  modelRuntime: RequestModelRuntime['runtime'];
  modelRegistry: ModelRegistry;
}

async function* streamSession(
  modules: PiTurnModules,
  turn: AuthorizedTurn
): AsyncGenerator<MessageChunk> {
  const { cwd, resumeSessionId, requestOptions, parsed } = turn;
  const nodeConfig = requestOptions?.nodeConfig;
  const settingsManager = modules.sessionSetup.seedPiSettings(modules.pi, cwd);
  const defaultToolNames = settingsManager.getDefaultTools();
  const options = yield* translateNodeOptions(modules, cwd, requestOptions, defaultToolNames);

  const { sessionManager, resumeFailed } = await modules.sessionResolver.resolvePiSession(
    cwd,
    resumeSessionId,
    requestOptions?.forkSession,
    requestOptions?.purpose === 'title-generation'
  );
  const resumed = resumeSessionId !== undefined && !resumeFailed;
  if (resumeFailed) {
    yield {
      type: 'warning',
      code: 'pi.resume_failed',
      message: 'Could not resume Pi session. Starting fresh conversation.',
    };
  }

  // Default ON: extensions (community packages like @plannotator/pi-extension
  // or your own local ones) are a core reason users run Pi. Opt out with
  // `assistants.pi.enableExtensions: false` in `.archon/config.yaml`.
  // Previously default-off, which silently broke
  // users who installed or built an extension and expected it to fire.
  //
  // Extension posture is resolved PER NODE (issue #2073): assistant-level
  // defaults can be overridden via `assistants.pi.nodes.<nodeId>` so that
  // e.g. only the planner node gets plannotator's `plan` flag and a
  // UI-capable context (hasUI), while an implement node runs without the
  // planning-mode edit guard. Direct chat (no nodeId) uses the defaults.
  //
  // The portable node-YAML `pi:` block (#2133) rides on `nodeConfig.pi` and is
  // the highest-precedence layer — it travels with the workflow, so a node
  // rename can't orphan it the way the node-id-keyed config map can.
  const extensions = resolvePiExtensionSettings(turn.piConfig, nodeConfig?.nodeId, nodeConfig?.pi);
  const resources = await modules.sessionSetup.loadPiResources(
    cwd,
    {
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.skillPaths.length > 0 ? { additionalSkillPaths: options.skillPaths } : {}),
    },
    extensions.enableExtensions,
    turn.modelRegistry,
    requestOptions?.abortSignal
  );

  getLog().info(
    {
      piProvider: parsed.provider,
      modelId: parsed.modelId,
      cwd,
      thinkingLevel: options.thinkingLevel,
      toolCount: options.filteredTools?.length,
      systemPromptSource: options.systemPrompt !== undefined ? 'explicit' : 'pi-builtin',
      skillCount: options.skillPaths.length,
      missingSkillCount: options.missingSkillCount,
      extensionsEnabled: extensions.enableExtensions,
      interactive: extensions.interactive,
      nodeId: nodeConfig?.nodeId,
      resumed,
    },
    'pi.session_started'
  );

  const outputFormat = requestOptions?.outputFormat;
  const structuredTool = outputFormat
    ? modules.structuredOutputTool.createStructuredOutputTool(outputFormat.schema)
    : undefined;
  const customTools = piCustomTools(
    modules,
    cwd,
    requestOptions,
    options.filteredTools,
    defaultToolNames,
    structuredTool?.definition
  );

  // A caller that aborted (the idle watchdog, a cancel) has stopped reading, so a
  // session started now would run unobserved.
  if (requestOptions?.abortSignal?.aborted) throw new Error('Query aborted');
  const extensionTurn =
    resources.extensionPaths.length > 0
      ? beginPiExtensionTurn(resources.extensionPaths, nodeConfig?.nodeId)
      : undefined;
  try {
    const { session, uiBridge } = yield* modules.sessionSetup.openPiSession(modules.pi, {
      cwd,
      parsed,
      model: turn.model,
      modelRuntime: turn.modelRuntime,
      modelRegistry: turn.modelRegistry,
      sessionManager,
      settingsManager,
      resources,
      thinkingLevel: options.thinkingLevel,
      customTools,
      resumed,
      extensions,
      extensionTurn,
    });
    structuredTool?.capFailedCalls(session);

    // Structured output (best-effort): the tool call cannot be forced, so the
    // prompt asks for it. When no valid call arrives, the bridge parses the
    // reply text instead, and the executor reasks or fails the node.
    const effectivePrompt = outputFormat
      ? modules.structuredOutputTool.augmentPromptForStructuredOutput(
          turn.prompt,
          outputFormat.schema
        )
      : turn.prompt;

    // Bridge callback-based events to the async generator contract.
    // bridgeSession owns dispose() and abort wiring. When `interactive`
    // is on, it also binds/unbinds the UI stub's emitter so extension
    // notifications land on the same queue as Pi events.
    const sem = await acquirePromptSlot(turn.piConfig.maxConcurrent, session, requestOptions);
    try {
      yield* withResumedOutcome(
        modules.eventBridge.bridgeSession(
          session,
          effectivePrompt,
          requestOptions?.abortSignal,
          structuredTool?.output,
          uiBridge,
          extensionTurn
        ),
        resumedOutcome(resumeSessionId, !resumeFailed)
      );
      getLog().info({ piProvider: parsed.provider }, 'pi.prompt_completed');
    } catch (err) {
      getLog().error({ err, piProvider: parsed.provider }, 'pi.prompt_failed');
      throw err;
    } finally {
      sem?.release();
    }
  } finally {
    extensionTurn?.close();
  }
}

/** The node's config in Pi SDK terms; unresolvable parts become warnings. */
interface PiNodeOptions {
  thinkingLevel: ReturnType<PiTurnModules['optionsTranslator']['resolvePiThinkingLevel']>['level'];
  filteredTools: ReturnType<PiTurnModules['optionsTranslator']['resolvePiTools']>['tools'];
  systemPrompt: string | undefined;
  skillPaths: string[];
  missingSkillCount: number;
}

/**
 * Translate Archon nodeConfig to Pi SDK options. All the translations
 * below correspond to capability flags declared `true` in
 * PI_CAPABILITIES; nodeConfig fields that don't map cleanly still
 * trigger a dag-executor warning upstream.
 */
async function* translateNodeOptions(
  { optionsTranslator }: PiTurnModules,
  cwd: string,
  requestOptions: SendQueryOptions | undefined,
  defaultToolNames: readonly string[] | undefined
): AsyncGenerator<MessageChunk, PiNodeOptions> {
  const nodeConfig = requestOptions?.nodeConfig;

  // thinkingLevel: Pi's native representation of Archon's `effort` field.
  const { level: thinkingLevel, warning: thinkingWarning } =
    optionsTranslator.resolvePiThinkingLevel(nodeConfig);
  if (thinkingWarning) {
    yield { type: 'warning', code: 'pi.thinking_level_ignored', message: thinkingWarning };
  }

  // tools: covers allowed_tools / denied_tools. `undefined` leaves Pi
  // defaults; an explicit empty array means "no tools" (valid idiom
  // matching e2e-claude-smoke's `allowed_tools: []`).
  // requestOptions.env (codebase-scoped env vars from .archon/config.yaml)
  // is injected into bash subprocesses via a BashSpawnHook, mirroring
  // Claude's options.env and Codex's constructor env.
  const { tools: filteredTools, unknownTools } = optionsTranslator.resolvePiTools(
    cwd,
    nodeConfig,
    requestOptions?.env,
    defaultToolNames
  );
  if (unknownTools.length > 0) {
    yield {
      type: 'warning',
      code: 'pi.unknown_tools',
      message: `Pi ignored unknown tool names: ${unknownTools.join(', ')}. Pi's built-in tools: read, bash, edit, write, grep, find, ls.`,
    };
  }

  // systemPrompt: request-level (AgentRequestOptions) wins over
  // node-level, which wins over `appendSystemPrompt`; any of them
  // overrides Pi's default. Pi only supports string system prompts, so
  // string[] is dropped. Validate each level INDEPENDENTLY before
  // applying precedence — a dropped request-level value must not win
  // via `??` and mask a valid node-level string.
  const systemPrompt =
    coerceStringPrompt(requestOptions?.systemPrompt, 'request') ??
    coerceStringPrompt(nodeConfig?.systemPrompt, 'node') ??
    requestOptions?.appendSystemPrompt;

  // skills: Archon uses name references (e.g. `skills: [agent-browser]`).
  // Resolve each name against .agents/skills and .claude/skills (project
  // + user-global). Resolved paths go through Pi's additionalSkillPaths;
  // Pi's buildSystemPrompt appends their agentskills.io XML block to
  // the system prompt automatically, so the model sees them.
  const { paths: skillPaths, missing: missingSkills } = optionsTranslator.resolvePiSkills(
    cwd,
    nodeConfig?.skills
  );
  if (missingSkills.length > 0) {
    yield {
      type: 'warning',
      code: 'pi.skills_unresolved',
      message: `Pi could not resolve skill names: ${missingSkills.join(', ')}. Searched .agents/skills and .claude/skills (project + user-global). Each must be a directory containing SKILL.md.`,
    };
  }

  return {
    thinkingLevel,
    filteredTools,
    systemPrompt,
    skillPaths,
    missingSkillCount: missingSkills.length,
  };
}

function coerceStringPrompt(
  value: SystemPromptInput | undefined,
  source: 'request' | 'node'
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  getLog().warn(
    { systemPromptType: typeof value, systemPromptSource: source },
    'pi.system_prompt_dropped_non_string'
  );
  return undefined;
}

/**
 * In-process tools (native tools such as manage_run, and the structured_output
 * tool) via Pi customTools. Because setting customTools forces
 * noTools:'builtin' (dropping Pi's defaults), an unrestricted node re-supplies
 * the same default tools a session without customTools would start with.
 */
function piCustomTools(
  { optionsTranslator, nativeTools }: PiTurnModules,
  cwd: string,
  requestOptions: SendQueryOptions | undefined,
  filteredTools: PiNodeOptions['filteredTools'],
  defaultToolNames: readonly string[] | undefined,
  structuredOutputTool: ToolDefinition | undefined
) {
  const addedTools = [
    ...(requestOptions?.nativeTools && requestOptions.nativeTools.length > 0
      ? nativeTools.buildPiNativeToolDefinitions(requestOptions.nativeTools)
      : []),
    ...(structuredOutputTool ? [structuredOutputTool] : []),
  ];
  const baseTools =
    filteredTools ??
    (addedTools.length > 0
      ? optionsTranslator.buildDefaultPiTools(cwd, requestOptions?.env, defaultToolNames)
      : undefined);
  return baseTools && [...baseTools, ...addedTools];
}

/**
 * Wait for a prompt slot when `maxConcurrent` caps Pi. The module-level semaphore
 * is initialized lazily from the first config that sets maxConcurrent and reused
 * for the lifetime of the process — this is a known v1 tradeoff. Pi concurrency is
 * global (one upstream backend) so a process-wide cap is the right scope. Disposes
 * the session when the wait fails.
 */
async function acquirePromptSlot(
  maxConcurrent: number | undefined,
  session: { dispose(): void },
  requestOptions: SendQueryOptions | undefined
): Promise<Semaphore | undefined> {
  if (maxConcurrent !== undefined && piSemaphore === undefined) {
    piSemaphore = new Semaphore(maxConcurrent);
    getLog().info({ maxConcurrent }, 'pi.semaphore_initialized');
  }

  // Snapshot before the first await — if a concurrent call initializes the
  // module-level piSemaphore after this point, sem stays undefined and the
  // caller's finally correctly skips release (we never acquired).
  const sem = piSemaphore;
  if (sem === undefined) return undefined;
  getLog().debug('pi.semaphore_acquiring');
  try {
    await sem.acquire(requestOptions?.abortSignal);
  } catch (err) {
    session.dispose();
    throw err;
  }
  getLog().debug('pi.semaphore_acquired');
  return sem;
}
