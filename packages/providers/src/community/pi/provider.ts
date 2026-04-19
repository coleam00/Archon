import { createLogger } from '@archon/paths';
import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  createAgentSession,
} from '@mariozechner/pi-coding-agent';
import { getModel, type Api, type Model } from '@mariozechner/pi-ai';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { PI_CAPABILITIES } from './capabilities';
import { parsePiConfig } from './config';
import { bridgeSession } from './event-bridge';
import { parsePiModelRef } from './model-ref';
import { resolvePiSkills, resolvePiThinkingLevel, resolvePiTools } from './options-translator';
import { createNoopResourceLoader } from './resource-loader';
import { resolvePiSession } from './session-resolver';
import { createArchonUIBridge, createArchonUIContext } from './ui-context-stub';

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
 * Typed wrapper around Pi's `getModel` for a runtime-string provider/model
 * pair. Pi's getModel signature constrains `TModelId` to
 * `keyof MODELS[TProvider]`, which isn't knowable from a runtime string —
 * the cast through `unknown` is the only way to bypass it. Isolating that
 * escape hatch behind one searchable name keeps it auditable.
 */
function lookupPiModel(provider: string, modelId: string): Model<Api> | undefined {
  return (getModel as unknown as (p: string, m: string) => Model<Api> | undefined)(
    provider,
    modelId
  );
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
 * (no reuse) with in-memory auth/session/settings, so the server never
 * touches `~/.pi/` and concurrent calls don't collide.
 *
 * v1 capabilities are all false (see `capabilities.ts`): sessionResume,
 * thinkingControl, skills, mcp, etc. map to Pi features but require
 * intentional wiring before they can be declared. Under-declaring is
 * honest; the dag-executor emits warnings for any nodeConfig field not
 * supported.
 */
export class PiProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const piConfig = parsePiConfig(assistantConfig);

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

    // 2. Look up the Model via Pi's static catalog. `lookupPiModel` returns
    //    undefined when not found; we guard explicitly below.
    const model = lookupPiModel(parsed.provider, parsed.modelId);
    if (!model) {
      throw new Error(
        `Pi model not found: provider='${parsed.provider}' model='${parsed.modelId}'. ` +
          'See https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/models.generated.ts for the Pi model catalog.'
      );
    }

    // 3. Build AuthStorage. `AuthStorage.create()` reads ~/.pi/agent/auth.json
    //    (or $PI_CODING_AGENT_DIR/auth.json), so any credential the user has
    //    populated via `pi` → `/login` (OAuth subscriptions: Claude Pro/Max,
    //    ChatGPT Plus, GitHub Copilot, Gemini CLI, Antigravity) or by editing
    //    the file directly (api_key entries) is picked up transparently.
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
    const authStorage = AuthStorage.create();

    const envVarName = PI_PROVIDER_ENV_VARS[parsed.provider];
    const envOverride = envVarName
      ? (requestOptions?.env?.[envVarName] ?? process.env[envVarName])
      : undefined;
    if (envOverride) {
      authStorage.setRuntimeApiKey(parsed.provider, envOverride);
    }

    // Fail-fast: resolve creds synchronously before spinning up a session.
    // Matches Claude's auth-error fast-fail pattern (no retry on auth failures).
    const resolvedKey = await authStorage.getApiKey(parsed.provider);
    if (!resolvedKey) {
      const envHint = envVarName
        ? `Set ${envVarName} in the environment or codebase env vars (.archon/config.yaml env: section).`
        : `Provider '${parsed.provider}' is not in the Archon adapter's env-var table — file an issue if you want a shortcut env var for it.`;
      const loginHint = `Or run \`pi\` and type \`/login\` locally to authenticate '${parsed.provider}' via OAuth; credentials land in ~/.pi/agent/auth.json and are picked up automatically.`;
      throw new Error(
        `Pi auth: no credentials for provider '${parsed.provider}'. ${envHint} ${loginHint}`
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

    // ModelRegistry + settings stay in-memory — only sessions persist, to
    // match Claude/Codex. Resource loader still suppresses filesystem
    // discovery by default, except for explicitly-passed skill paths and —
    // when piConfig.enableExtensions is true — Pi's community extension
    // ecosystem (tools + lifecycle hooks from ~/.pi/agent/extensions/ and
    // packages installed via `pi install npm:<pkg>`).
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory();
    const enableExtensions = piConfig.enableExtensions === true;
    // Interactive UI binding is only meaningful when extensions are loaded:
    // Pi binds the UI context against the runner built from loaded extensions,
    // so without extensions there is nothing to consume hasUI. Silently clamp
    // to false (rather than warn) — a Pi workflow switching extensions on and
    // off by node shouldn't spam logs about redundant interactive flags.
    const interactive = enableExtensions && piConfig.interactive === true;
    const resourceLoader = createNoopResourceLoader(cwd, {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
      ...(enableExtensions ? { enableExtensions: true } : {}),
    });

    // Extensions are only actually loaded during reload(). createAgentSession
    // skips this step when the caller supplies their own resource loader (see
    // pi-coding-agent/dist/core/sdk.js: the reload() call is gated on
    // `!resourceLoader`). Without this call, `getExtensions()` returns the
    // empty default and Pi never constructs an ExtensionRunner — so
    // `session.extensionRunner` is undefined and `setFlagValue` silently
    // no-ops. Only reload when extensions are enabled; the other resource
    // types (skills, prompts, themes, context files) are suppressed via
    // `no*` flags on the loader, so reloading them would do nothing useful
    // and just wastes IO.
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

    // 4e. Extension flag pass-through. Pi's ExtensionRunner is already
    //     constructed inside `createAgentSession` (via `_buildRuntime`), so
    //     flag values can be applied before `bindExtensions` emits
    //     `session_start`. This matters because extensions read their flags
    //     *in* their `session_start` handler — setting flags after the event
    //     fires is a no-op. Example: `extensionFlags: { plan: true }` is
    //     equivalent to `pi --plan` on the CLI, which plannotator reads during
    //     its startup handler to enter the planning phase.
    if (enableExtensions && piConfig.extensionFlags) {
      const runner = session.extensionRunner;
      if (runner) {
        for (const [name, value] of Object.entries(piConfig.extensionFlags)) {
          runner.setFlagValue(name, value);
        }
      }
    }

    // 4f. Force plannotator (and any Pi extension following its convention)
    //     into "remote session" mode. plannotator-browser.ts only calls
    //     `ctx.ui.notify("Remote session. Open manually: <url>")` when
    //     `openBrowser()` returns `{ isRemote: true }`; on a local session
    //     it silently spawns `xdg-open`/`start` instead, which opens a
    //     browser on whatever host the Archon server happens to be running
    //     on — invisible to workflow users and untestable from a bash
    //     assertion node. From the workflow runner's perspective every
    //     Archon execution IS remote: nobody is watching the server host's
    //     desktop; the user is consuming Archon's event stream. Setting
    //     PLANNOTATOR_REMOTE=1 here flips plannotator's heuristic so its
    //     URL always goes through notify(), which our ExtensionUIContext
    //     stub forwards as an assistant chunk — landing in $nodeId.output
    //     for downstream bash/script nodes AND in the user's stream to
    //     click. Respect an explicit operator override (PLANNOTATOR_REMOTE=0
    //     for same-laptop setups where auto-open is fine).
    if (interactive && process.env.PLANNOTATOR_REMOTE === undefined) {
      process.env.PLANNOTATOR_REMOTE = '1';
    }

    // 4g. Interactive extension UI. Bind a minimal ExtensionUIContext so
    //     extensions see `ctx.hasUI === true` and can fire `ctx.ui.notify()`.
    //     Plannotator, for example, emits its browser URL through notify()
    //     on a remote session — without a bound UI context it silently
    //     auto-approves every plan and never surfaces the URL. The stub
    //     forwards notifications into the same chunk stream as assistant
    //     output via `uiBridge`, wired in/out of bridgeSession's queue.
    //
    //     This call also fires `session_start` to extensions, so any flag
    //     values set above must already be in place before reaching here.
    const uiBridge = interactive ? createArchonUIBridge() : undefined;
    if (uiBridge) {
      const uiContext = createArchonUIContext(uiBridge);
      await session.bindExtensions({ uiContext });
    } else if (enableExtensions) {
      // Extensions loaded without an interactive UI binding still need a
      // session_start emission so flag reads happen. Pi's internal
      // `noOpUIContext` is already set; we just need to trigger the event.
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
