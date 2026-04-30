import { createLogger } from '@archon/paths';
import type { OmpAuthStorage, OmpCreateAgentSessionOptions } from './sdk-loader';
import { loadOmpSdk } from './sdk-loader';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { OMP_CAPABILITIES } from './capabilities';
import { parseOmpConfig } from './config';
import { bridgeSession } from './event-bridge';
import { parseOmpModelRef } from './model-ref';
import {
  getRuntimeAuthOverride,
  resolveOmpSkills,
  resolveOmpThinkingLevel,
  resolveOmpToolNames,
} from './options-translator';
import { resolveOmpSession } from './session-resolver';
import { createArchonOmpUIBridge, createArchonOmpUIContext } from './ui-context-stub';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.omp');
  return cachedLog;
}

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
 * Oh My Pi community provider. Uses Archon YAML/config as the canonical
 * behavior surface while wiring OMP's auth/model/session primitives directly.
 */
export class OmpProvider implements IAgentProvider {
  constructor(private readonly sdkLoader: typeof loadOmpSdk = loadOmpSdk) {}

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const ompConfig = parseOmpConfig(assistantConfig);

    const modelRef = requestOptions?.model ?? ompConfig.model;
    const sdk = await this.sdkLoader();
    if (!modelRef) {
      throw new Error(
        'Oh My Pi provider requires a model. Set `model` on the workflow node or `assistants.omp.model` in .archon/config.yaml. ' +
          "Format: '<omp-provider-id>/<model-id>' (e.g. 'anthropic/claude-sonnet-4-5')."
      );
    }

    const parsed = parseOmpModelRef(modelRef);
    if (!parsed) {
      throw new Error(
        `Invalid Oh My Pi model ref: '${modelRef}'. Expected format '<omp-provider-id>/<model-id>' (e.g. 'anthropic/claude-sonnet-4-5').`
      );
    }

    let authStorage: OmpAuthStorage;
    try {
      authStorage = await sdk.discoverAuthStorage(ompConfig.agentDir);
    } catch (err) {
      const e = err as Error;
      getLog().error({ err: e, ompProvider: parsed.provider }, 'omp.auth_storage_init_failed');
      throw new Error(
        `Oh My Pi auth storage init failed: ${e.message}. Check that your OMP agent database is readable.`
      );
    }

    const runtimeOverride = getRuntimeAuthOverride(parsed.provider, requestOptions?.env);
    if (runtimeOverride) {
      authStorage.setRuntimeApiKey(parsed.provider, runtimeOverride);
    }

    const modelRegistry = new sdk.ModelRegistry(authStorage);
    modelRegistry.refreshInBackground();
    const model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) {
      getLog().error(
        { ompProvider: parsed.provider, modelId: parsed.modelId },
        'omp.model_not_found'
      );
      throw new Error(
        `Oh My Pi model not found: provider='${parsed.provider}' model='${parsed.modelId}'. ` +
          'Check the OMP model catalog or your custom model registry.'
      );
    }

    const resolvedKey = await authStorage.getApiKey(parsed.provider);
    if (!resolvedKey) {
      throw new Error(
        `Oh My Pi auth: no credentials for provider '${parsed.provider}'. ` +
          'Run `omp` locally to authenticate or set the provider API key in the environment/codebase env vars.'
      );
    }

    const nodeConfig = requestOptions?.nodeConfig;
    const { level: thinkingLevel, warning: thinkingWarning } = resolveOmpThinkingLevel(nodeConfig);
    if (thinkingWarning) yield { type: 'system', content: `⚠️ ${thinkingWarning}` };

    const { toolNames, unknownTools } = resolveOmpToolNames(nodeConfig, ompConfig);
    if (unknownTools.length > 0) {
      yield {
        type: 'system',
        content: `⚠️ Oh My Pi ignored unknown tool names: ${unknownTools.join(', ')}.`,
      };
    }

    const { skills, missing: missingSkills } = await resolveOmpSkills(
      sdk,
      cwd,
      nodeConfig?.skills,
      ompConfig.agentDir
    );
    if (missingSkills.length > 0) {
      yield {
        type: 'system',
        content: `⚠️ Oh My Pi could not resolve skill names: ${missingSkills.join(', ')}.`,
      };
    }

    const { sessionManager, resumeFailed } = await resolveOmpSession(
      sdk,
      cwd,
      resumeSessionId,
      ompConfig.agentDir
    );
    if (resumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume Oh My Pi session. Starting fresh conversation.',
      };
    }

    const systemPrompt = requestOptions?.systemPrompt ?? nodeConfig?.systemPrompt;
    const settings = sdk.Settings.isolated({});
    const uiBridge = createArchonOmpUIBridge();

    getLog().info(
      {
        ompProvider: parsed.provider,
        modelId: parsed.modelId,
        cwd,
        thinkingLevel,
        toolCount: toolNames.length,
        skillCount: skills.length,
        missingSkillCount: missingSkills.length,
        resumed: resumeSessionId !== undefined && !resumeFailed,
      },
      'omp.session_started'
    );

    const sessionOptions: OmpCreateAgentSessionOptions = {
      cwd,
      ...(ompConfig.agentDir ? { agentDir: ompConfig.agentDir } : {}),
      model,
      authStorage,
      modelRegistry,
      sessionManager,
      settings,
      skills,
      enableMCP: ompConfig.enableMCP === true,
      enableLsp: ompConfig.enableLsp !== false,
      disableExtensionDiscovery: ompConfig.disableExtensionDiscovery !== false,
      ...(ompConfig.additionalExtensionPaths
        ? { additionalExtensionPaths: ompConfig.additionalExtensionPaths }
        : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      toolNames,
      hasUI: true,
    };

    const agentSessionResult = await sdk.createAgentSession(sessionOptions);
    agentSessionResult.setToolUIContext(createArchonOmpUIContext(uiBridge), true);
    const { session, modelFallbackMessage } = agentSessionResult;

    if (modelFallbackMessage) {
      yield { type: 'system', content: `⚠️ ${modelFallbackMessage}` };
    }

    const outputFormat = requestOptions?.outputFormat;
    const effectivePrompt = outputFormat
      ? augmentPromptForJsonSchema(prompt, outputFormat.schema)
      : prompt;

    try {
      yield* bridgeSession(
        session,
        effectivePrompt,
        requestOptions?.abortSignal,
        outputFormat?.schema,
        uiBridge
      );
      getLog().info({ ompProvider: parsed.provider }, 'omp.prompt_completed');
    } catch (err) {
      getLog().error({ err, ompProvider: parsed.provider }, 'omp.prompt_failed');
      throw err;
    }
  }

  getType(): string {
    return 'omp';
  }

  getCapabilities(): ProviderCapabilities {
    return OMP_CAPABILITIES;
  }
}
