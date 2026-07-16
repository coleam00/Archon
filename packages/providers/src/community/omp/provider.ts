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
import { augmentPromptForJsonSchema } from '../../shared/structured-output';
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
  selectAppliedConfigEnv,
  restoreConfigEnv,
} from './options-translator';
import { buildOmpNativeToolDefinitions } from './native-tools';
import { resolveOmpSession } from './session-resolver';
import { createArchonOmpUIBridge, createArchonOmpUIContext } from './ui-context-stub';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.omp');
  return cachedLog;
}

type ConfigEnvLeaseRelease = () => void;
type ConfigEnvLeaseReject = (error: Error) => void;
interface ConfigEnvWaiter {
  exclusive: boolean;
  resolve: (release: ConfigEnvLeaseRelease) => void;
  reject: ConfigEnvLeaseReject;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
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
    resolveConfigEnvWaiter(next, createWriterRelease());
    return;
  }

  while (configEnvWaiters[0] && !configEnvWaiters[0].exclusive) {
    const waiter = configEnvWaiters.shift();
    if (!waiter) break;
    configEnvReaders += 1;
    resolveConfigEnvWaiter(waiter, createReaderRelease());
  }
}

function abortConfigEnvWaiter(waiter: ConfigEnvWaiter): void {
  if (waiter.settled) return;
  waiter.settled = true;
  if (waiter.onAbort && waiter.abortSignal) {
    waiter.abortSignal.removeEventListener('abort', waiter.onAbort);
  }
  const index = configEnvWaiters.indexOf(waiter);
  if (index >= 0) configEnvWaiters.splice(index, 1);
  waiter.reject(new Error('Oh My Pi request aborted while waiting for config env lease.'));
}

function resolveConfigEnvWaiter(waiter: ConfigEnvWaiter, release: ConfigEnvLeaseRelease): void {
  if (waiter.settled) {
    release();
    return;
  }
  waiter.settled = true;
  if (waiter.onAbort && waiter.abortSignal) {
    waiter.abortSignal.removeEventListener('abort', waiter.onAbort);
  }
  waiter.resolve(release);
}

export async function acquireConfigEnvLease(
  exclusive: boolean,
  abortSignal?: AbortSignal
): Promise<ConfigEnvLeaseRelease> {
  if (abortSignal?.aborted) {
    throw new Error('Oh My Pi request aborted while waiting for config env lease.');
  }

  if (exclusive) {
    if (!configEnvWriterActive && configEnvReaders === 0 && configEnvWaiters.length === 0) {
      configEnvWriterActive = true;
      return createWriterRelease();
    }
  } else if (!configEnvWriterActive && configEnvWaiters.length === 0) {
    configEnvReaders += 1;
    return createReaderRelease();
  }

  return await new Promise((resolve, reject) => {
    const waiter: ConfigEnvWaiter = {
      exclusive,
      resolve,
      reject,
      ...(abortSignal ? { abortSignal } : {}),
      settled: false,
    };
    if (abortSignal) {
      waiter.onAbort = (): void => {
        abortConfigEnvWaiter(waiter);
      };
      abortSignal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    configEnvWaiters.push(waiter);
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

export function extensionFlagWarning(
  extensionFlagsConfigured: boolean,
  hasRunner: boolean
): string | undefined {
  if (!extensionFlagsConfigured || hasRunner) return undefined;
  return '⚠️ Oh My Pi ignored extensionFlags because no OMP extension runner was loaded.';
}

export function mcpEnvWarning(missingVars: readonly string[]): string | undefined {
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

function filterExtraToolsByPolicy<T>(
  tools: readonly T[],
  getName: (tool: T) => string | undefined,
  allowedTools: ReadonlySet<string> | undefined,
  deniedTools: ReadonlySet<string>
): T[] {
  if (allowedTools === undefined && deniedTools.size === 0) return [...tools];

  return tools.filter(tool => {
    const toolName = getName(tool);
    if (toolName === undefined) return allowedTools === undefined;
    const normalized = toolName.toLowerCase();
    if (deniedTools.has(normalized)) return false;
    return allowedTools === undefined || allowedTools.has(normalized);
  });
}

function toLowerToolSet(names: readonly string[] | undefined): Set<string> {
  return new Set((names ?? []).map(name => name.toLowerCase()));
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
    const nodeConfig = requestOptions?.nodeConfig;
    const parsed = requireParsedModelRef(requestOptions?.model ?? ompConfig.model);
    const requiresExclusiveConfigEnvLease = hasConfigEnv(ompConfig.env);
    const releaseConfigEnvLease = await acquireConfigEnvLease(
      requiresExclusiveConfigEnvLease,
      requestOptions?.abortSignal
    );
    let configEnvKeysApplied: string[] = [];
    let resolvedMcp: ResolvedOmpMcp | undefined;
    let sendQueryError: unknown;
    let disconnectError: Error | undefined;
    let sdkManagedMcp: OmpMcpManager | undefined;
    let sessionForCleanup: OmpSession | undefined;

    try {
      if (requiresExclusiveConfigEnvLease) {
        configEnvKeysApplied = applyConfigEnv(ompConfig.env);
        if (configEnvKeysApplied.length > 0) {
          getLog().debug({ keys: configEnvKeysApplied }, 'omp.config_env_applied');
        }
      }

      const { level: thinkingLevel, warning: thinkingWarning } =
        resolveOmpThinkingLevel(nodeConfig);
      if (thinkingWarning) yield { type: 'system', content: `⚠️ ${thinkingWarning}` };

      const nativeToolRequestNames = toLowerToolSet(
        requestOptions?.nativeTools?.map(tool => tool.name)
      );
      const { toolNames, unknownTools, unknownDeniedTools } = resolveOmpToolNames(
        nodeConfig,
        ompConfig
      );
      const unsupportedDeniedTools = unknownDeniedTools.filter(
        name => !nativeToolRequestNames.has(name.toLowerCase())
      );
      if (unsupportedDeniedTools.length > 0) {
        throw new Error(
          `Oh My Pi denied_tools contains unknown tool names: ${unsupportedDeniedTools.join(', ')}. Fix the tool name or remove it so Archon does not leave the tool enabled by mistake.`
        );
      }
      const unsupportedAllowedTools = unknownTools.filter(
        name => !nativeToolRequestNames.has(name.toLowerCase())
      );
      if (unsupportedAllowedTools.length > 0) {
        yield {
          type: 'system',
          content: `⚠️ Oh My Pi ignored unknown tool names: ${unsupportedAllowedTools.join(', ')}.`,
        };
      }

      const allowedExtraToolNames = nodeConfig?.allowed_tools
        ? new Set([...nodeConfig.allowed_tools, ...toolNames].map(name => name.toLowerCase()))
        : undefined;
      const deniedExtraToolNames = toLowerToolSet(nodeConfig?.denied_tools);

      const sdk = await this.sdkLoader();
      const authStorage = await discoverAuthStorageOrThrow(
        sdk,
        ompConfig.agentDir,
        parsed.provider
      );

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
        ompConfig.agentDir,
        requestOptions?.forkSession === true,
        requestOptions?.persistSession !== false
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

      const appliedConfigEnv = selectAppliedConfigEnv(ompConfig.env, configEnvKeysApplied);
      const runtimeOverride =
        getRuntimeAuthOverride(parsed.provider, requestOptions?.env) ??
        getRuntimeAuthOverride(parsed.provider, appliedConfigEnv);
      if (runtimeOverride) authStorage.setRuntimeApiKey(parsed.provider, runtimeOverride);
      if (fallbackModel) {
        const fallbackRuntimeOverride =
          getRuntimeAuthOverride(fallbackModel.provider, requestOptions?.env) ??
          getRuntimeAuthOverride(fallbackModel.provider, appliedConfigEnv);
        if (fallbackRuntimeOverride) {
          authStorage.setRuntimeApiKey(fallbackModel.provider, fallbackRuntimeOverride);
        }
      }

      const { modelRegistry, model } = await resolveSessionModel(sdk, authStorage, parsed);

      const fallbackModelInstance = fallbackModel
        ? modelRegistry.find(fallbackModel.provider, fallbackModel.modelId)
        : undefined;
      if (fallbackModel && !fallbackModelInstance) {
        throw new Error(
          `Oh My Pi fallback model not found: provider='${fallbackModel.provider}' model='${fallbackModel.modelId}'. Check the OMP model catalog or your custom model registry.`
        );
      }
      if (fallbackModel && !(await modelRegistry.getApiKey(fallbackModelInstance, undefined))) {
        throw new Error(
          `Oh My Pi fallback model has no usable auth: provider='${fallbackModel.provider}' model='${fallbackModel.modelId}'. Configure credentials for the fallback provider before setting fallbackModel.`
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
        const mcpEnvSource = requestOptions?.env
          ? { ...process.env, ...requestOptions.env }
          : process.env;
        resolvedMcp = await resolveOmpMcp(sdk, cwd, nodeConfig.mcp, authStorage, mcpEnvSource);
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

      const effectiveMcpCustomTools = resolvedMcp
        ? filterExtraToolsByPolicy(
            resolvedMcp.customTools,
            getToolName,
            allowedExtraToolNames,
            deniedExtraToolNames
          )
        : [];
      const effectiveMcpToolNames = resolvedMcp
        ? filterExtraToolsByPolicy(
            resolvedMcp.toolNames,
            name => name,
            allowedExtraToolNames,
            deniedExtraToolNames
          )
        : [];
      const nativeTools =
        requestOptions?.nativeTools && requestOptions.nativeTools.length > 0
          ? buildOmpNativeToolDefinitions(requestOptions.nativeTools)
          : [];
      const effectiveNativeTools = filterExtraToolsByPolicy(
        nativeTools,
        tool => tool.name,
        allowedExtraToolNames,
        deniedExtraToolNames
      );
      const nativeToolNames = effectiveNativeTools.map(tool => tool.name);
      const customTools =
        effectiveMcpCustomTools.length > 0 || effectiveNativeTools.length > 0
          ? [...effectiveMcpCustomTools, ...effectiveNativeTools]
          : undefined;
      const extraToolNames = [...effectiveMcpToolNames, ...nativeToolNames];
      const effectiveToolNames =
        extraToolNames.length > 0 ? mergeToolNames(toolNames, extraToolNames) : toolNames;
      const envInjectionExtension = createBashEnvInjectionExtension(requestOptions?.env);
      const enableSdkMcp = nodeConfig?.mcp ? true : ompConfig.enableMCP === true;
      const hasStartupUi = interactive && !(enableSdkMcp && !resolvedMcp);
      const sessionOptions: OmpCreateAgentSessionOptions = {
        cwd,
        ...(ompConfig.agentDir ? { agentDir: ompConfig.agentDir } : {}),
        ...(ompConfig.spawns !== undefined ? { spawns: ompConfig.spawns } : {}),
        model,
        authStorage,
        modelRegistry,
        sessionManager,
        settings,
        skills,
        enableMCP: enableSdkMcp,
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
        ...(customTools ? { customTools } : {}),
        toolNames: effectiveToolNames,
        hasUI: hasStartupUi,
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
      try {
        restoreConfigEnv(configEnvKeysApplied);
      } catch (err) {
        getLog().error({ err }, 'omp.config_env_restore_failed');
      } finally {
        releaseConfigEnvLease();
      }
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
