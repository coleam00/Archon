import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { PI_CAPABILITIES } from './capabilities';
import { parsePiConfig } from './config';
import { parsePiModelRef } from './model-ref';

// IMPORTANT: Do NOT add static `import { ... } from '@mariozechner/*'` here,
// and do NOT statically import sibling modules that themselves import runtime
// values from Pi (options-translator, resource-loader, session-resolver,
// ui-context-stub, event-bridge). Pi's `@mariozechner/pi-coding-agent/dist/config.js`
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
function ensurePiPackageDirShim(): void {
  const shimDir = join(tmpdir(), 'archon-pi-shim');
  const shimPkgJson = join(shimDir, 'package.json');
  if (!existsSync(shimPkgJson)) {
    mkdirSync(shimDir, { recursive: true });
    // `piConfig: {}` is explicit so Pi's defaults (`name: 'pi'`,
    // `configDir: '.pi'`) kick in — matches Pi's standalone behavior.
    writeFileSync(
      shimPkgJson,
      JSON.stringify({
        name: 'archon-pi-shim',
        version: '0.0.0',
        piConfig: {},
      })
    );
  }
  process.env.PI_PACKAGE_DIR = shimDir;
}

/**
 * Map Pi provider id → env var name used by pi-ai's getEnvApiKey().
 * Kept small and explicit: v1 supports the most common API-key providers.
 * OAuth flows (Anthropic subscription, Google Gemini CLI, etc.) are out of
 * scope — Archon is a server-side platform and doesn't drive interactive
 * login. Extend only when a provider is actually exercised.
 *
 * Cross-reference (authoritative mapping maintained upstream in Pi):
 *   https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/env-api-keys.ts
 */
const PI_PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
};

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

/**
 * Append a "respond with JSON matching this schema" instruction to the user
 * prompt so Pi-backed models produce parseable structured output. Pi's SDK
 * has no JSON-mode equivalent to Claude's outputFormat or Codex's
 * outputSchema, so this is a best-effort fallback: the event bridge parses
 * the assistant transcript on agent_end. Models that reliably follow
 * instruction (GPT-5, Claude, Gemini 2.x, recent Qwen Coder, DeepSeek V3)
 * return clean JSON; models that don't produce a parse failure, which the
 * executor surfaces via the existing dag.structured_output_missing warning.
 */
export function augmentPromptForJsonSchema(
  prompt: string,
  schema: Record<string, unknown>
): string {
  return `${prompt}

---

CRITICAL: Respond with ONLY a JSON object matching the schema below. No prose before or after the JSON. No markdown code fences. Just the raw JSON object as your final message.

Schema:
${JSON.stringify(schema, null, 2)}`;
}

/**
 * Pi community provider — wraps `@mariozechner/pi-coding-agent`'s full
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
      { resolvePiSkills, resolvePiThinkingLevel, resolvePiTools },
      { createNoopResourceLoader },
      { resolvePiSession },
      { createArchonUIBridge, createArchonUIContext },
    ] = await Promise.all([
      import('@mariozechner/pi-coding-agent'),
      import('./event-bridge'),
      import('./options-translator'),
      import('./resource-loader'),
      import('./session-resolver'),
      import('./ui-context-stub'),
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

    const authStorage = piCodingAgent.AuthStorage.create();
    const modelRegistry = piCodingAgent.ModelRegistry.create(authStorage);
    // 2. Look up the Model via Pi's Registry. `modelRegistry.find` returns
    //    undefined when not found; we guard explicitly below.
    const model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) {
      throw new Error(
        `Pi model not found: provider='${parsed.provider}' model='${parsed.modelId}'. ` +
          'See https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/models.generated.ts for the Pi model catalog.'
      );
    }

    // 3. Build AuthStorage. `AuthStorage.create()`, above, read ~/.pi/agent/auth.json
    //    (or $PI_CODING_AGENT_DIR/auth.json), so any credentials the user has
    //    populated via `pi` → `/login` (OAuth subscriptions: Claude Pro/Max,
    //    ChatGPT Plus, GitHub Copilot, Gemini CLI, Antigravity) or by editing
    //    the file directly (api_key entries) are picked up transparently.
    //
    //    Per-request env vars override the file via setRuntimeApiKey — this
    //    mirrors Claude's process-env + request-env merge pattern and
    //    ensures codebase-scoped env vars (from .archon/config.yaml `env:`)
    //    win over the user's global Pi login.
    //
    //    Pi's internal resolution order:
    //      1. runtime override  (our setRuntimeApiKey below)
    //      2. auth.json api_key entry
    //      3. auth.json oauth entry  (auto-refreshes expired tokens)
    //      4. env var fallback  (Pi's getEnvApiKey, e.g. ANTHROPIC_API_KEY)
    //
    //    OAuth refresh note: Pi refreshes expired access tokens against the
    //    provider's OAuth server and rewrites ~/.pi/agent/auth.json under a
    //    file lock (same mechanism pi CLI uses — safe for concurrent access).

    const envVarName = PI_PROVIDER_ENV_VARS[parsed.provider];
    const envOverride = envVarName
      ? (requestOptions?.env?.[envVarName] ?? process.env[envVarName])
      : undefined;
    if (envOverride) {
      authStorage.setRuntimeApiKey(parsed.provider, envOverride);
    }

    const resolvedKey = await authStorage.getApiKey(parsed.provider);
    if (!resolvedKey) {
      if (envVarName) {
        const envHint = `Set ${envVarName} in the environment or codebase env vars (.archon/config.yaml env: section).`;
        const loginHint = `Or run \`pi\` and type \`/login\` locally to authenticate '${parsed.provider}' via OAuth; credentials land in ~/.pi/agent/auth.json and are picked up automatically.`;
        throw new Error(
          `Pi auth: no credentials for provider '${parsed.provider}'. ${envHint} ${loginHint}`
        );
      }

      const envHint = `Provider '${parsed.provider}' is not in the Archon adapter's env-var table — file an issue if you want a shortcut env var for it.`;
      const loginHint = `Or run \`pi\` and type \`/login\` locally to authenticate '${parsed.provider}' via OAuth; credentials land in ~/.pi/agent/auth.json and are picked up automatically.`;
      // No credentials for unmapped providers is not necessarily a problem, e.g., local models.
      getLog().info(
        {
          piProvider: parsed.provider,
          msg: `No Pi credentials found for provider. ${envHint} ${loginHint}`,
        },
        'pi.auth_missing'
      );
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
    const systemPrompt = requestOptions?.systemPrompt ?? nodeConfig?.systemPrompt;

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

    // Settings stay in-memory — only sessions persist, to match Claude/Codex.
    // Resource loader still suppresses filesystem except for explicitly-passed
    // skill paths and — when piConfig.enableExtensions is true — Pi's community
    // extension ecosystem (tools + lifecycle hooks from ~/.pi/agent/extensions/
    // and packages installed via `pi install npm:<pkg>`).
    const settingsManager = piCodingAgent.SettingsManager.inMemory();
    // Default ON: extensions (community packages like @plannotator/pi-extension
    // or your own local ones) are a core reason users run Pi. Opt out with
    // `assistants.pi.enableExtensions: false` (or `interactive: false`) in
    // `.archon/config.yaml`. Previously default-off, which silently broke
    // users who installed or built an extension and expected it to fire.
    const enableExtensions = piConfig.enableExtensions !== false;
    // Clamp to false without extensions: nothing consumes hasUI without a runner.
    const interactive = enableExtensions && piConfig.interactive !== false;
    const resourceLoader = createNoopResourceLoader(cwd, {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
      ...(enableExtensions ? { enableExtensions: true } : {}),
    });

    // Required: without reload(), session.extensionRunner is undefined and
    // setFlagValue silently no-ops. createAgentSession skips this when a
    // custom resource loader is supplied.
    if (enableExtensions) {
      await resourceLoader.reload();
    }

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

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd,
      model,
      authStorage,
      modelRegistry,
      sessionManager,
      settingsManager,
      resourceLoader,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(filteredTools !== undefined ? { tools: filteredTools } : {}),
    });

    if (modelFallbackMessage) {
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

    // 4f. Bind UI context (so ctx.hasUI is true and ctx.ui.notify() forwards
    //     into the chunk stream) or fire session_start with no UI. Must run
    //     after flag pass-through above.
    const uiBridge = interactive ? createArchonUIBridge() : undefined;
    if (uiBridge) {
      const uiContext = createArchonUIContext(uiBridge);
      await session.bindExtensions({ uiContext });
    } else if (enableExtensions) {
      await session.bindExtensions({});
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
    }
  }

  getType(): string {
    return 'pi';
  }

  getCapabilities(): ProviderCapabilities {
    return PI_CAPABILITIES;
  }
}
