import { join } from 'node:path';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { getOrderedAgents } from './agent-config';
import { OPENCODE_CAPABILITIES } from './capabilities';
import { parseModelRef, parseOpencodeConfig } from './config';
import { classifyOpencodeError, enrichOpencodeError } from './errors';
import { materializeAgents } from './agent-fs';
import { streamMultiAgentOpencodeSession } from './multi-agent';
import {
  acquireEmbeddedRuntime,
  disposeInstanceForDirectory,
  releaseEmbeddedRuntime,
} from './runtime';
import { resolveSessionId, streamOpencodeSession } from './session';

export { parseModelRef } from './config';
export { resetEmbeddedRuntime } from './runtime';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

let cachedLog: ReturnType<typeof createLogger> | undefined;

function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class OpencodeProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = parseOpencodeConfig(requestOptions?.assistantConfig ?? {});
    const modelRef = requestOptions?.model ?? assistantConfig.model;
    const parsedModelOrNull = modelRef ? parseModelRef(modelRef) : undefined;

    if (modelRef && !parsedModelOrNull) {
      throw new Error(
        `Invalid OpenCode model ref: '${modelRef}'. Expected format '<provider>/<model>' (for example 'anthropic/claude-3-5-sonnet').`
      );
    }

    if (!parsedModelOrNull) {
      throw new Error(
        'OpenCode requires a model to be specified. ' +
          'Set model in assistants config (e.g., model: anthropic/claude-3-5-sonnet).'
      );
    }

    const parsedModel = parsedModelOrNull;

    const nodeAgents = requestOptions?.nodeConfig?.agents;
    const nodeId = requestOptions?.nodeConfig?.nodeId;
    const orderedAgents = getOrderedAgents(requestOptions?.nodeConfig);
    const hasAgentConfig = orderedAgents.length > 0;
    const isMultiAgent = orderedAgents.length > 1;
    const usingExternalBaseUrl = Boolean(assistantConfig.baseUrl);
    if (usingExternalBaseUrl) {
      throw new Error(
        'OpenCode external baseUrl mode is no longer supported. ' +
          'Archon now requires managed embedded OpenCode runtime for fully controlled agent lifecycle.'
      );
    }

    const sessionCwd =
      hasAgentConfig && nodeId && !usingExternalBaseUrl
        ? join(cwd, '.archon-opencode', nodeId)
        : cwd;

    let lastError: Error | undefined;
    let recoveredAgentNotFound = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('OpenCode query aborted');
      }

      const runtime = await (async (): Promise<{
        client: import('./runtime').OpencodeClientLike;
        release: () => void;
      }> => {
        const embedded = await acquireEmbeddedRuntime(requestOptions?.abortSignal);
        return {
          client: embedded.client,
          release: (): void => {
            releaseEmbeddedRuntime(embedded);
          },
        };
      })();

      try {
        // When agents are defined, use a per-node session directory so each node
        // gets its own OpenCode InstanceState — preventing stale agent cache from
        // previous nodes in the same workflow run.
        // For multi-agent, materialize each agent in its own subdirectory.
        if (hasAgentConfig) {
          if (isMultiAgent) {
            // Materialize all agents in the shared sessionCwd so the single
            // event subscription catches events from every child session.
            await materializeAgents(sessionCwd, nodeAgents ?? {});
            await disposeInstanceForDirectory(runtime.client, sessionCwd);
          } else if (nodeAgents) {
            await materializeAgents(sessionCwd, nodeAgents);
            await disposeInstanceForDirectory(runtime.client, sessionCwd);
          }
        }

        if (isMultiAgent) {
          yield* streamMultiAgentOpencodeSession(
            runtime.client,
            sessionCwd,
            prompt,
            parsedModel,
            requestOptions
          );
          return;
        }

        const { sessionId, resumed } = await resolveSessionId(
          runtime.client,
          sessionCwd,
          resumeSessionId
        );
        if (resumeSessionId && !resumed) {
          yield {
            type: 'system',
            content: '⚠️ Could not resume OpenCode session. Starting fresh conversation.',
          };
        }

        yield* streamOpencodeSession(
          runtime.client,
          sessionCwd,
          sessionId,
          prompt,
          parsedModel,
          requestOptions
        );
        return;
      } catch (error) {
        const errorClass = classifyOpencodeError(
          error,
          requestOptions?.abortSignal?.aborted === true
        );
        const enrichedError = enrichOpencodeError(error, errorClass);
        const shouldRetry =
          errorClass === 'rate_limit' ||
          errorClass === 'crash' ||
          (errorClass === 'agent_not_found' && hasAgentConfig && !recoveredAgentNotFound);

        getLog().error(
          {
            err: error,
            errorClass,
            attempt,
            maxRetries: MAX_RETRIES,
          },
          'opencode.query_failed'
        );

        if (!shouldRetry || attempt >= MAX_RETRIES - 1) {
          throw enrichedError;
        }

        if (errorClass === 'agent_not_found') {
          recoveredAgentNotFound = true;
          getLog().info({ attempt, sessionCwd }, 'opencode.retrying_after_agent_refresh');
        }

        const delayMs = this.retryBaseDelayMs * 2 ** attempt;
        getLog().info({ attempt, delayMs, errorClass }, 'opencode.retrying_query');
        await delay(delayMs);
        lastError = enrichedError;
      } finally {
        runtime.release();
      }
    }

    throw lastError ?? new Error('OpenCode query failed after retries');
  }

  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return OPENCODE_CAPABILITIES;
  }
}
