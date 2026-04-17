import { createLogger } from '@archon/paths';
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
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
import { createNoopResourceLoader } from './resource-loader';

/**
 * Map Pi provider id → env var name used by pi-ai's getEnvApiKey().
 * Kept small and explicit: v1 supports the most common API-key providers.
 * OAuth flows (Anthropic subscription, Google Gemini CLI, etc.) are out of
 * scope — Archon is a server-side platform and doesn't drive interactive
 * login. Extend only when a provider is actually exercised.
 *
 * Cross-reference:
 *   /tmp/pi-research/pi-mono/packages/ai/src/env-api-keys.ts
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
    // v1: resumeSessionId ignored (sessionResume: false). Logging the
    // attempt surfaces confusion if Archon sends one for a Pi run.
    if (resumeSessionId) {
      getLog().debug({ sessionId: resumeSessionId }, 'pi.resume_ignored');
    }

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

    // 2. Look up the Model via Pi's static catalog. getModel() returns
    //    undefined (cast as Model) when not found; we guard explicitly.
    //    Cast through `unknown` because getModel's generics constrain
    //    TModelId to `keyof MODELS[TProvider]`, which we don't have at
    //    compile time from a runtime string.
    const model = (getModel as unknown as (p: string, m: string) => Model<Api> | undefined)(
      parsed.provider,
      parsed.modelId
    );
    if (!model) {
      throw new Error(
        `Pi model not found: provider='${parsed.provider}' model='${parsed.modelId}'. ` +
          'See https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/models.generated.ts for the Pi model catalog.'
      );
    }

    // 3. Seed AuthStorage per-request from options.env (codebase env vars)
    //    + process.env. Mirrors Claude's `{...subprocessEnv, ...requestOptions.env}`
    //    merge at packages/providers/src/claude/provider.ts:889-890.
    const envVarName = PI_PROVIDER_ENV_VARS[parsed.provider];
    if (!envVarName) {
      throw new Error(
        `Pi auth: provider '${parsed.provider}' is not yet supported by the Archon Pi adapter. ` +
          'Supported: ' +
          Object.keys(PI_PROVIDER_ENV_VARS).join(', ') +
          '. File an issue if you need another Pi provider enabled.'
      );
    }
    const apiKey = requestOptions?.env?.[envVarName] ?? process.env[envVarName];
    if (!apiKey) {
      throw new Error(
        `Pi auth: missing API key for provider '${parsed.provider}'. ` +
          `Set ${envVarName} in the environment or in the codebase env vars (.archon/config.yaml env: section).`
      );
    }
    const authStorage = AuthStorage.inMemory({
      [parsed.provider]: { type: 'api_key', key: apiKey },
    });

    // 4. Build no-fs primitives. These keep the server quiescent w.r.t. the
    //    ~/.pi/ directory and make concurrent sendQuery calls race-free.
    const sessionManager = SessionManager.inMemory(cwd);
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = createNoopResourceLoader(cwd);

    getLog().info(
      { piProvider: parsed.provider, modelId: parsed.modelId, cwd },
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
    });

    if (modelFallbackMessage) {
      yield { type: 'system', content: `⚠️ ${modelFallbackMessage}` };
    }

    // 5. Bridge callback-based events to the async generator contract.
    //    bridgeSession owns dispose() and abort wiring.
    try {
      yield* bridgeSession(session, prompt, requestOptions?.abortSignal);
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
