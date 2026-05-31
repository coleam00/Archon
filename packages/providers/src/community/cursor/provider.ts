/**
 * Cursor provider (community tier).
 *
 * Implements `IAgentProvider` on top of @cursor/sdk. Resolves auth, model,
 * runtime (local/cloud), MCP servers, and structured output, then bridges
 * the SDK run stream via `bridgeRun`.
 *
 * Module-scope invariant: type-only imports from @cursor/sdk. All value imports
 * happen inside `sendQuery()` via dynamic `await import(...)`.
 */
import { createLogger } from '@archon/paths';
import type { AgentOptions, ModelSelection, McpServerConfig, SendOptions } from '@cursor/sdk';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { loadMcpConfig } from '../../mcp/config';
import { augmentPromptForJsonSchema } from '../../shared/structured-output';
import { CURSOR_CAPABILITIES } from './capabilities';
import { parseCursorConfig, type CursorProviderDefaults } from './config';
import { bridgeRun } from './event-bridge';
import { awaitBunCursorHttp2Tail, installBunCursorHttp2Guard } from './bun-http2-guard';
import { resolveModelId, resolveModelParams, toModelSelection } from './model-params';

const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.cursor');
  return cachedLog;
}

interface ProviderWarning {
  code: string;
  message: string;
}

function buildMergedEnv(requestEnv?: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...baseEnv, ...(requestEnv ?? {}) };
}

function resolveApiKey(
  mergedEnv: Record<string, string>,
  cursorConfig: CursorProviderDefaults
): string | undefined {
  const fromEnv = mergedEnv[CURSOR_API_KEY_ENV];
  if (fromEnv) return fromEnv;
  return cursorConfig.apiKey;
}

function resolveSystemPromptAppend(requestOptions?: SendQueryOptions): string | undefined {
  const requestPrompt = requestOptions?.systemPrompt;
  const nodePrompt =
    typeof requestOptions?.nodeConfig?.systemPrompt === 'string'
      ? requestOptions.nodeConfig.systemPrompt
      : undefined;
  const content = requestPrompt ?? nodePrompt;
  return typeof content === 'string' && content.length > 0 ? content : undefined;
}

async function loadMcpServersForSend(
  nodeConfig: SendQueryOptions['nodeConfig'] | undefined,
  cwd: string,
  mergedEnv: Record<string, string>,
  warnings: ProviderWarning[]
): Promise<Record<string, McpServerConfig> | undefined> {
  const mcpPath = nodeConfig?.mcp;
  if (typeof mcpPath !== 'string' || mcpPath.length === 0) return undefined;

  const { servers, serverNames, missingVars } = await loadMcpConfig(mcpPath, cwd, mergedEnv);
  if (missingVars.length > 0) {
    warnings.push({
      code: 'cursor.mcp_env_vars_missing',
      message: `Cursor MCP config references undefined env vars: ${missingVars.join(', ')}. Servers using them may fail at runtime.`,
    });
  }

  getLog().info({ serverNames, missingVars }, 'cursor.mcp_loaded');
  return servers as Record<string, McpServerConfig>;
}

function buildAgentOptions(
  cursorConfig: CursorProviderDefaults,
  requestOptions: SendQueryOptions | undefined,
  cwd: string,
  model: ModelSelection,
  warnings: ProviderWarning[]
): AgentOptions {
  const runtime = cursorConfig.runtime ?? 'local';

  if (runtime === 'cloud') {
    const repos = cursorConfig.cloudRepos;
    if (!repos || repos.length === 0) {
      throw new Error(
        'Cursor cloud runtime requires `assistants.cursor.cloudRepos` in .archon/config.yaml (or repo config).'
      );
    }
    return {
      model,
      mode: cursorConfig.mode ?? 'agent',
      cloud: { repos },
    };
  }

  if (requestOptions?.nodeConfig?.sandbox !== undefined) {
    warnings.push({
      code: 'cursor.sandbox_node_ignored',
      message:
        'Cursor ignores workflow node `sandbox` — use `assistants.cursor.enableSandbox` in config instead.',
    });
  }

  return {
    model,
    mode: cursorConfig.mode ?? 'agent',
    local: {
      cwd,
      settingSources: cursorConfig.settingSources ?? [],
      ...(cursorConfig.enableSandbox ? { sandboxOptions: { enabled: true } } : {}),
    },
  };
}

function buildFriendlyCursorError(error: unknown): Error {
  const message =
    error instanceof Error && error.message.length > 0 ? error.message : String(error);

  const normalized = message.toLowerCase();
  if (
    normalized.includes('auth') ||
    normalized.includes('api key') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return new Error(
      `Cursor authentication failed: ${message}\n\n` +
        'Set CURSOR_API_KEY in the environment or assistants.cursor.apiKey in .archon/config.yaml.'
    );
  }

  return error instanceof Error ? error : new Error(message);
}

export class CursorProvider implements IAgentProvider {
  getType(): string {
    return 'cursor';
  }

  getCapabilities(): ProviderCapabilities {
    return CURSOR_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const log = getLog();
    const removeHttp2Guard = installBunCursorHttp2Guard();

    try {
      if (requestOptions?.forkSession !== undefined) {
        log.debug(
          { option: 'forkSession', value: requestOptions.forkSession },
          'cursor.option_logged'
        );
      }
      if (requestOptions?.persistSession !== undefined) {
        log.debug(
          { option: 'persistSession', value: requestOptions.persistSession },
          'cursor.option_logged'
        );
      }

      const assistantConfig = requestOptions?.assistantConfig ?? {};
      const cursorConfig = parseCursorConfig(assistantConfig);
      const mergedEnv = buildMergedEnv(requestOptions?.env);
      const apiKey = resolveApiKey(mergedEnv, cursorConfig);

      if (!apiKey) {
        throw new Error(
          'Cursor API key is required. Set CURSOR_API_KEY or assistants.cursor.apiKey in .archon/config.yaml.'
        );
      }

      const warnings: ProviderWarning[] = [];
      const modelParams = resolveModelParams(requestOptions?.nodeConfig, cursorConfig);
      if (modelParams.warning) {
        warnings.push({ code: 'cursor.reasoning_ignored', message: modelParams.warning });
      }

      const modelId = resolveModelId(requestOptions?.model, cursorConfig);
      const model = toModelSelection(modelId, modelParams.params);

      const agentOptions = buildAgentOptions(cursorConfig, requestOptions, cwd, model, warnings);
      agentOptions.apiKey = apiKey;

      for (const warning of warnings) {
        yield { type: 'system', content: `⚠️ ${warning.message}` };
      }

      const outputFormat = requestOptions?.outputFormat;
      const wantsStructured = outputFormat?.type === 'json_schema';
      let effectivePrompt = wantsStructured
        ? augmentPromptForJsonSchema(prompt, outputFormat.schema)
        : prompt;

      const systemAppend = resolveSystemPromptAppend(requestOptions);
      if (systemAppend) {
        effectivePrompt = `${systemAppend}\n\n---\n\n${effectivePrompt}`;
      }

      const sdk = await import('@cursor/sdk');
      const cursorSdkAgent = sdk.Agent;

      const wantsFork = requestOptions?.forkSession === true;
      let resumeFailed = false;
      let forkedToFresh = false;

      let agent: Awaited<ReturnType<typeof cursorSdkAgent.create>>;
      try {
        if (resumeSessionId && !wantsFork) {
          log.debug({ agentId: resumeSessionId, cwd }, 'cursor.resume_attempt');
          try {
            agent = await cursorSdkAgent.resume(resumeSessionId, agentOptions);
          } catch (err) {
            log.debug({ err, agentId: resumeSessionId }, 'cursor.resume_failed_creating_fresh');
            resumeFailed = true;
            agent = await cursorSdkAgent.create(agentOptions);
          }
        } else {
          if (resumeSessionId && wantsFork) {
            log.warn(
              { requestedAgentId: resumeSessionId },
              'cursor.fork_unsupported_creating_fresh'
            );
            forkedToFresh = true;
          } else {
            log.debug({ cwd }, 'cursor.create_agent');
          }
          agent = await cursorSdkAgent.create(agentOptions);
        }
      } catch (err) {
        throw buildFriendlyCursorError(err);
      }

      if (resumeFailed) {
        yield {
          type: 'system',
          content: '⚠️ Could not resume Cursor agent — starting a fresh conversation.',
        };
      } else if (forkedToFresh) {
        yield {
          type: 'system',
          content:
            '⚠️ Cursor SDK does not support session forking; starting a fresh conversation to keep retries safe.',
        };
      }

      const mcpWarnings: ProviderWarning[] = [];
      const mcpServers = await loadMcpServersForSend(
        requestOptions?.nodeConfig,
        cwd,
        mergedEnv,
        mcpWarnings
      );
      for (const warning of mcpWarnings) {
        yield { type: 'system', content: `⚠️ ${warning.message}` };
      }

      const sendOptions: SendOptions = {
        ...(mcpServers ? { mcpServers } : {}),
        ...(wantsFork ? { local: { force: true } } : {}),
      };

      log.info(
        {
          agentId: agent.agentId,
          model: model.id,
          cwd,
          runtime: cursorConfig.runtime ?? 'local',
          resumed: resumeSessionId !== undefined && !resumeFailed && !forkedToFresh,
          mcpServers: mcpServers ? Object.keys(mcpServers).length : 0,
        },
        'cursor.agent_started'
      );

      try {
        const run = await agent.send(effectivePrompt, sendOptions);
        yield* bridgeRun(
          run,
          agent.agentId,
          requestOptions?.abortSignal,
          wantsStructured ? outputFormat.schema : undefined
        );
        log.info({ agentId: agent.agentId, runId: run.id }, 'cursor.prompt_completed');
      } catch (err) {
        log.error({ err, agentId: agent.agentId }, 'cursor.prompt_failed');
        throw buildFriendlyCursorError(err);
      } finally {
        try {
          agent.close();
        } catch (closeErr) {
          log.debug({ err: closeErr, agentId: agent.agentId }, 'cursor.agent_close_failed');
        }
      }
    } finally {
      await awaitBunCursorHttp2Tail();
      removeHttp2Guard();
    }
  }
}
