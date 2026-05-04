import { createLogger } from '@archon/paths';
import type {
  OmpAuthStorage,
  OmpCodingAgentSdk,
  OmpCreateAgentSessionOptions,
  OmpModelRegistry,
} from './sdk-loader';

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
import { resolveOmpMcp, type ResolvedOmpMcp } from './mcp';
import { parseOmpModelRef } from './model-ref';
import {
  applyConfigEnv,
  buildOmpSettingsOverrides,
  getRuntimeAuthOverride,
  resolveOmpSkills,
  resolveOmpThinkingLevel,
  resolveOmpToolNames,
  restoreConfigEnv,
} from './options-translator';
import { resolveOmpSession } from './session-resolver';
import { createArchonOmpUIBridge, createArchonOmpUIContext } from './ui-context-stub';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.omp');
  return cachedLog;
}

let configEnvLock: Promise<void> = Promise.resolve();

async function acquireConfigEnvLock(): Promise<() => void> {
  let release: (() => void) | undefined;
  const previous = configEnvLock;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  configEnvLock = previous.then(
    () => current,
    () => current
  );
  await previous.catch(() => undefined);
  return () => {
    release?.();
  };
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

type ParsedModelRef = NonNullable<ReturnType<typeof parseOmpModelRef>>;

function requireParsedModelRef(modelRef: string | undefined): ParsedModelRef {
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

  return parsed;
}

async function discoverAuthStorageOrThrow(
  sdk: OmpCodingAgentSdk,
  agentDir: string | undefined,
  provider: string
): Promise<OmpAuthStorage> {
  try {
    return await sdk.discoverAuthStorage(agentDir);
  } catch (err) {
    const error = err as Error;
    getLog().error({ err: error, ompProvider: provider }, 'omp.auth_storage_init_failed');
    throw new Error(
      `Oh My Pi auth storage init failed: ${error.message}. Check that your OMP agent database is readable.`
    );
  }
}

function resolveSessionModel(
  sdk: OmpCodingAgentSdk,
  authStorage: OmpAuthStorage,
  parsed: ParsedModelRef
): { modelRegistry: OmpModelRegistry; model: unknown } {
  const modelRegistry = new sdk.ModelRegistry(authStorage);
  modelRegistry.refreshInBackground();

  const model = modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model) {
    getLog().error(
      { ompProvider: parsed.provider, modelId: parsed.modelId },
      'omp.model_not_found'
    );
    throw new Error(
      `Oh My Pi model not found: provider='${parsed.provider}' model='${parsed.modelId}'. Check the OMP model catalog or your custom model registry.`
    );
  }

  return { modelRegistry, model };
}

async function ensureProviderCredentials(
  authStorage: OmpAuthStorage,
  parsed: ParsedModelRef
): Promise<void> {
  const resolvedKey = await authStorage.getApiKey(parsed.provider);
  if (resolvedKey) return;

  throw new Error(
    `Oh My Pi auth: no credentials for provider '${parsed.provider}'. Run \`omp\` locally to authenticate or set the provider API key in the environment/codebase env vars.`
  );
}

function logSessionStart(args: {
  provider: string;
  modelId: string;
  cwd: string;
  thinkingLevel: string | undefined;
  toolCount: number;
  skillCount: number;
  missingSkillCount: number;
  resumed: boolean;
  settingsOverrideCount: number;
  configEnvKeysApplied: number;
  interactive: boolean;
  extensionsDisabled: boolean;
}): void {
  getLog().info(
    {
      ompProvider: args.provider,
      modelId: args.modelId,
      cwd: args.cwd,
      thinkingLevel: args.thinkingLevel,
      toolCount: args.toolCount,
      skillCount: args.skillCount,
      missingSkillCount: args.missingSkillCount,
      resumed: args.resumed,
      settingsOverrideCount: args.settingsOverrideCount,
      configEnvKeysApplied: args.configEnvKeysApplied,
      interactive: args.interactive,
      extensionsDisabled: args.extensionsDisabled,
    },
    'omp.session_started'
  );
}

function extensionFlagWarning(
  extensionFlagsConfigured: boolean,
  hasRunner: boolean
): string | undefined {
  if (!extensionFlagsConfigured || hasRunner) return undefined;
  return '⚠️ Oh My Pi ignored extensionFlags because no OMP extension runner was loaded.';
}

function mcpEnvWarning(missingVars: readonly string[]): string | undefined {
  if (missingVars.length === 0) return undefined;
  const uniqueVars = [...new Set(missingVars)];
  return `⚠️ MCP config references undefined env vars: ${uniqueVars.join(', ')}. These will be empty strings — MCP servers may fail to authenticate.`;
}

function mergeToolNames(baseToolNames: string[], mcpToolNames: string[]): string[] {
  return [...new Set([...baseToolNames, ...mcpToolNames])];
}

function getToolName(tool: unknown): string | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined;
  const name = (tool as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function filterDeniedMcpTools(
  mcp: ResolvedOmpMcp,
  deniedTools: readonly string[] | undefined
): Pick<ResolvedOmpMcp, 'customTools' | 'toolNames'> {
  if (!deniedTools || deniedTools.length === 0) {
    return { customTools: mcp.customTools, toolNames: mcp.toolNames };
  }

  const denied = new Set(deniedTools.map(name => name.toLowerCase()));
  const customTools = mcp.customTools.filter(tool => {
    const toolName = getToolName(tool);
    return toolName === undefined || !denied.has(toolName.toLowerCase());
  });
  const toolNames = mcp.toolNames.filter(name => !denied.has(name.toLowerCase()));
  return { customTools, toolNames };
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
    let configEnvKeysApplied: string[] = [];

    const parsed = requireParsedModelRef(requestOptions?.model ?? ompConfig.model);
    const sdk = await this.sdkLoader();
    const authStorage = await discoverAuthStorageOrThrow(sdk, ompConfig.agentDir, parsed.provider);

    const runtimeOverride = getRuntimeAuthOverride(parsed.provider, requestOptions?.env);
    if (runtimeOverride) authStorage.setRuntimeApiKey(parsed.provider, runtimeOverride);

    const { modelRegistry, model } = resolveSessionModel(sdk, authStorage, parsed);
    await ensureProviderCredentials(authStorage, parsed);

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
    const settingsOverrides = buildOmpSettingsOverrides(ompConfig);
    const settings = sdk.Settings.isolated(settingsOverrides);
    const interactive = ompConfig.interactive !== false;
    const extensionsDisabled = ompConfig.disableExtensionDiscovery === true;
    const uiBridge = interactive ? createArchonOmpUIBridge() : undefined;

    const releaseConfigEnvLock = await acquireConfigEnvLock();
    configEnvKeysApplied = applyConfigEnv(ompConfig.env);
    if (configEnvKeysApplied.length > 0) {
      getLog().debug({ keys: configEnvKeysApplied }, 'omp.config_env_applied');
    }

    let resolvedMcp: ResolvedOmpMcp | undefined;
    try {
      if (nodeConfig?.mcp) {
        resolvedMcp = await resolveOmpMcp(sdk, cwd, nodeConfig.mcp, authStorage);
        getLog().info(
          { serverNames: resolvedMcp.serverNames, mcpPath: nodeConfig.mcp },
          'omp.mcp_config_loaded'
        );

        const envWarning = mcpEnvWarning(resolvedMcp.missingVars);
        if (envWarning) {
          getLog().warn(
            { missingVars: [...new Set(resolvedMcp.missingVars)] },
            'omp.mcp_env_vars_missing'
          );
          yield { type: 'system', content: envWarning };
        }

        for (const mcpError of resolvedMcp.errors) {
          getLog().warn(
            { mcpPath: nodeConfig.mcp, serverName: mcpError.path, error: mcpError.error },
            'omp.mcp_tool_load_failed'
          );
          yield {
            type: 'system',
            content: `MCP server connection failed: ${mcpError.path} (${mcpError.error})`,
          };
        }
      }

      const effectiveMcpTools = resolvedMcp
        ? filterDeniedMcpTools(resolvedMcp, nodeConfig?.denied_tools)
        : undefined;
      const effectiveToolNames = effectiveMcpTools
        ? mergeToolNames(toolNames, effectiveMcpTools.toolNames)
        : toolNames;
      const sessionOptions: OmpCreateAgentSessionOptions = {
        cwd,
        ...(ompConfig.agentDir ? { agentDir: ompConfig.agentDir } : {}),
        model,
        authStorage,
        modelRegistry,
        sessionManager,
        settings,
        skills,
        enableMCP: nodeConfig?.mcp ? true : ompConfig.enableMCP === true,
        enableLsp: ompConfig.enableLsp !== false,
        ...(ompConfig.disableExtensionDiscovery !== undefined
          ? { disableExtensionDiscovery: ompConfig.disableExtensionDiscovery }
          : {}),
        ...(ompConfig.additionalExtensionPaths
          ? { additionalExtensionPaths: ompConfig.additionalExtensionPaths }
          : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(resolvedMcp ? { mcpManager: resolvedMcp.manager } : {}),
        ...(effectiveMcpTools ? { customTools: effectiveMcpTools.customTools } : {}),
        toolNames: effectiveToolNames,
        hasUI: interactive,
      };

      logSessionStart({
        provider: parsed.provider,
        modelId: parsed.modelId,
        cwd,
        thinkingLevel,
        toolCount: effectiveToolNames.length,
        skillCount: skills.length,
        missingSkillCount: missingSkills.length,
        resumed: resumeSessionId !== undefined && !resumeFailed,
        settingsOverrideCount: Object.keys(settingsOverrides).length,
        configEnvKeysApplied: configEnvKeysApplied.length,
        interactive,
        extensionsDisabled,
      });

      const agentSessionResult = await sdk.createAgentSession(sessionOptions);
      const { session, modelFallbackMessage } = agentSessionResult;

      if (ompConfig.extensionFlags && session.extensionRunner) {
        for (const [name, value] of Object.entries(ompConfig.extensionFlags)) {
          session.extensionRunner.setFlagValue(name, value);
        }
      }

      const extensionWarning = extensionFlagWarning(
        ompConfig.extensionFlags !== undefined,
        session.extensionRunner !== undefined
      );
      if (extensionWarning) {
        yield { type: 'system', content: extensionWarning };
      }

      if (uiBridge) {
        agentSessionResult.setToolUIContext(createArchonOmpUIContext(uiBridge), true);
      }

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
    } finally {
      if (resolvedMcp) {
        try {
          await resolvedMcp.manager.disconnectAll();
        } catch (err) {
          getLog().warn({ err, mcpPath: nodeConfig?.mcp }, 'omp.mcp_disconnect_failed');
        }
      }
      restoreConfigEnv(configEnvKeysApplied);
      releaseConfigEnvLock?.();
    }
  }

  getType(): string {
    return 'omp';
  }

  getCapabilities(): ProviderCapabilities {
    return OMP_CAPABILITIES;
  }
}
