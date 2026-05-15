import { createLogger } from '@archon/paths';
import type {
  OmpAuthStorage,
  OmpCodingAgentSdk,
  OmpCreateAgentSessionOptions,
  OmpExtensionFactory,
  OmpMcpManager,
  OmpModelRegistry,
  OmpSession,
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
import {
  combineCleanupError,
  disconnectOmpMcpManager,
  normalizeOmpError,
  resolveOmpMcp,
  type ResolvedOmpMcp,
} from './mcp';
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

type ConfigEnvLeaseRelease = () => void;
interface ConfigEnvWaiter {
  exclusive: boolean;
  resolve: (release: ConfigEnvLeaseRelease) => void;
}

let configEnvReaders = 0;
let configEnvWriterActive = false;
const configEnvWaiters: ConfigEnvWaiter[] = [];

function createReaderRelease(): ConfigEnvLeaseRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    configEnvReaders -= 1;
    if (configEnvReaders === 0) flushConfigEnvWaiters();
  };
}

function createWriterRelease(): ConfigEnvLeaseRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    configEnvWriterActive = false;
    flushConfigEnvWaiters();
  };
}

function flushConfigEnvWaiters(): void {
  if (configEnvWriterActive || configEnvReaders > 0 || configEnvWaiters.length === 0) return;

  const next = configEnvWaiters[0];
  if (next?.exclusive) {
    configEnvWaiters.shift();
    configEnvWriterActive = true;
    next.resolve(createWriterRelease());
    return;
  }

  while (configEnvWaiters[0] && !configEnvWaiters[0].exclusive) {
    const waiter = configEnvWaiters.shift();
    if (!waiter) break;
    configEnvReaders += 1;
    waiter.resolve(createReaderRelease());
  }
}

async function acquireConfigEnvLease(exclusive: boolean): Promise<ConfigEnvLeaseRelease> {
  if (exclusive) {
    if (!configEnvWriterActive && configEnvReaders === 0 && configEnvWaiters.length === 0) {
      configEnvWriterActive = true;
      return createWriterRelease();
    }
  } else if (!configEnvWriterActive && configEnvWaiters.length === 0) {
    configEnvReaders += 1;
    return createReaderRelease();
  }

  return await new Promise(resolve => {
    configEnvWaiters.push({ exclusive, resolve });
    flushConfigEnvWaiters();
  });
}

function hasConfigEnv(env: Record<string, string> | undefined): env is Record<string, string> {
  return env !== undefined && Object.keys(env).length > 0;
}

function createBashEnvInjectionExtension(
  env: Record<string, string> | undefined
): OmpExtensionFactory | undefined {
  if (!hasConfigEnv(env)) return undefined;

  return api => {
    api.on('tool_call', event => {
      if (event.toolName !== 'bash') return;

      const toolEnv = event.input.env;
      event.input.env =
        toolEnv && typeof toolEnv === 'object' && !Array.isArray(toolEnv)
          ? { ...env, ...(toolEnv as Record<string, string>) }
          : env;
    });
  };
}

export function augmentPromptForJsonSchema(
  prompt: string,
  schema: Record<string, unknown>
): string {
  return `${prompt}

---

CRITICAL: Respond with ONLY valid JSON matching the schema below. No prose before or after the JSON. No markdown code fences. Just the raw JSON value as your final message.

Schema:
${JSON.stringify(schema, null, 2)}`;
}

function toOmpSystemPromptBlocks(
  systemPrompt: SendQueryOptions['systemPrompt']
): string[] | undefined {
  if (typeof systemPrompt === 'string') return [systemPrompt];
  if (Array.isArray(systemPrompt) && systemPrompt.every(block => typeof block === 'string')) {
    return systemPrompt;
  }
  if (systemPrompt !== undefined) {
    getLog().warn(
      { systemPromptType: Array.isArray(systemPrompt) ? 'array' : typeof systemPrompt },
      'omp.system_prompt_dropped_non_string'
    );
  }
  return undefined;
}
type ParsedModelRef = NonNullable<ReturnType<typeof parseOmpModelRef>>;
const OMP_FALLBACK_THINKING_LEVELS = new Set([
  'inherit',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

interface ParsedFallbackModelRef extends ParsedModelRef {
  selector: string;
}

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

function formatParsedModelRef(parsed: ParsedModelRef): string {
  return `${parsed.provider}/${parsed.modelId}`;
}

function requireParsedFallbackModelRef(
  modelRef: string | undefined
): ParsedFallbackModelRef | undefined {
  if (modelRef === undefined) return undefined;

  const parsed = parseOmpModelRef(modelRef);
  if (!parsed) {
    throw new Error(
      `Invalid Oh My Pi fallback model ref: '${modelRef}'. Expected format '<omp-provider-id>/<model-id>' (e.g. 'anthropic/claude-haiku-4-5').`
    );
  }

  const colonIndex = parsed.modelId.lastIndexOf(':');
  if (colonIndex > 0) {
    const suffix = parsed.modelId.slice(colonIndex + 1);
    if (OMP_FALLBACK_THINKING_LEVELS.has(suffix)) {
      return { ...parsed, modelId: parsed.modelId.slice(0, colonIndex), selector: modelRef };
    }
  }

  return { ...parsed, selector: modelRef };
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

async function resolveSessionModel(
  sdk: OmpCodingAgentSdk,
  authStorage: OmpAuthStorage,
  parsed: ParsedModelRef
): Promise<{ modelRegistry: OmpModelRegistry; model: unknown }> {
  const modelRegistry = new sdk.ModelRegistry(authStorage);
  await modelRegistry.refresh();

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

    const systemPromptBlocks = toOmpSystemPromptBlocks(
      requestOptions?.systemPrompt ?? nodeConfig?.systemPrompt
    );
    const fallbackModel = requireParsedFallbackModelRef(
      requestOptions?.fallbackModel ?? nodeConfig?.fallbackModel
    );
    let settingsOverrides: Record<string, unknown> = {};
    const interactive = ompConfig.interactive !== false;
    const extensionsDisabled = ompConfig.disableExtensionDiscovery === true;
    const uiBridge = interactive ? createArchonOmpUIBridge() : undefined;
    // Env-free sessions may run together, but sessions that inject assistants.omp.env
    // need exclusive access so other prompts never observe temporary process.env state.
    const requiresExclusiveConfigEnvLease = hasConfigEnv(ompConfig.env);
    const releaseConfigEnvLease = await acquireConfigEnvLease(requiresExclusiveConfigEnvLease);
    if (requiresExclusiveConfigEnvLease) {
      configEnvKeysApplied = applyConfigEnv(ompConfig.env);
      if (configEnvKeysApplied.length > 0) {
        getLog().debug({ keys: configEnvKeysApplied }, 'omp.config_env_applied');
      }
    }

    let resolvedMcp: ResolvedOmpMcp | undefined;
    let sendQueryError: unknown;
    let disconnectError: Error | undefined;
    let sdkManagedMcp: OmpMcpManager | undefined;
    let sessionForCleanup: OmpSession | undefined;
    try {
      const runtimeOverride =
        getRuntimeAuthOverride(parsed.provider, requestOptions?.env) ??
        getRuntimeAuthOverride(parsed.provider, ompConfig.env);
      if (runtimeOverride) authStorage.setRuntimeApiKey(parsed.provider, runtimeOverride);
      if (fallbackModel) {
        const fallbackRuntimeOverride =
          getRuntimeAuthOverride(fallbackModel.provider, requestOptions?.env) ??
          getRuntimeAuthOverride(fallbackModel.provider, ompConfig.env);
        if (fallbackRuntimeOverride) {
          authStorage.setRuntimeApiKey(fallbackModel.provider, fallbackRuntimeOverride);
        }
      }

      const { modelRegistry, model } = await resolveSessionModel(sdk, authStorage, parsed);

      if (fallbackModel && !modelRegistry.find(fallbackModel.provider, fallbackModel.modelId)) {
        throw new Error(
          `Oh My Pi fallback model not found: provider='${fallbackModel.provider}' model='${fallbackModel.modelId}'. Check the OMP model catalog or your custom model registry.`
        );
      }

      settingsOverrides = buildOmpSettingsOverrides(
        ompConfig,
        fallbackModel
          ? {
              primaryModel: formatParsedModelRef(parsed),
              fallbackModel: fallbackModel.selector,
            }
          : undefined
      );
      const settings = sdk.Settings.isolated(settingsOverrides);

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
      const envInjectionExtension = createBashEnvInjectionExtension(requestOptions?.env);
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
        ...(envInjectionExtension ? { extensions: [envInjectionExtension] } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(systemPromptBlocks !== undefined ? { systemPrompt: systemPromptBlocks } : {}),
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
      sessionForCleanup = session;
      sdkManagedMcp =
        agentSessionResult.mcpManager && agentSessionResult.mcpManager !== resolvedMcp?.manager
          ? agentSessionResult.mcpManager
          : undefined;

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

      sessionForCleanup = undefined;
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
    } catch (err) {
      sendQueryError = err;
    } finally {
      if (sessionForCleanup) {
        try {
          await Promise.resolve(sessionForCleanup.dispose());
        } catch (err) {
          getLog().debug({ err }, 'omp.provider.dispose_unbridged_session_failed');
        } finally {
          sessionForCleanup = undefined;
        }
      }
      if (resolvedMcp) {
        disconnectError = await disconnectOmpMcpManager(
          resolvedMcp.manager,
          'Oh My Pi MCP teardown failed'
        );
        if (disconnectError) {
          getLog().error(
            { err: disconnectError, mcpPath: nodeConfig?.mcp },
            'omp.mcp_disconnect_failed'
          );
        }
      }
      if (sdkManagedMcp) {
        const sdkDisconnectError = await disconnectOmpMcpManager(
          sdkManagedMcp,
          'Oh My Pi SDK-managed MCP teardown failed'
        );
        if (sdkDisconnectError) {
          getLog().error({ err: sdkDisconnectError }, 'omp.sdk_mcp_disconnect_failed');
          disconnectError = disconnectError
            ? combineCleanupError(
                disconnectError,
                sdkDisconnectError,
                'Multiple Oh My Pi MCP teardowns failed.'
              )
            : sdkDisconnectError;
        }
      }
      restoreConfigEnv(configEnvKeysApplied);
      releaseConfigEnvLease();
    }

    if (disconnectError) {
      if (sendQueryError) {
        throw combineCleanupError(
          sendQueryError,
          disconnectError,
          'Oh My Pi request failed and MCP teardown also failed.'
        );
      }
      throw disconnectError;
    }

    if (sendQueryError) throw normalizeOmpError(sendQueryError, 'Oh My Pi request failed.');
  }

  getType(): string {
    return 'omp';
  }

  getCapabilities(): ProviderCapabilities {
    return OMP_CAPABILITIES;
  }
}
