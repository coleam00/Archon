import { join } from 'node:path';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
  TokenUsage,
} from '../../types';

import { getOrderedAgents } from './agent-config';
import { getOpencodeCapabilities } from './capabilities';
import { parseModelRef, parseOpencodeConfig } from './config';
import { classifyOpencodeError, enrichOpencodeError } from './errors';
import { materializeAgents } from './agent-fs';
import { streamMultiAgentOpencodeSession } from './multi-agent';
import {
  acquireEmbeddedRuntime,
  disposeInstanceForDirectory,
  releaseEmbeddedRuntime,
} from './runtime';
import { acquireV2Runtime } from './runtime-v2';
import { resolveSessionId, streamOpencodeSession } from './session';
import {
  OpencodeV2RetryableError,
  resolveSessionIdV2,
  streamOpencodeSessionV2,
  summarizeOpencodeV2Usage,
} from './session-v2';
import { withResumedOutcome, resumedOutcome } from '../../shared/resumed';

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

function includePriorV2Usage(chunk: MessageChunk, priorUsage: readonly TokenUsage[]): MessageChunk {
  if (chunk.type !== 'result' || priorUsage.length === 0) return chunk;
  const tokens = summarizeOpencodeV2Usage([...priorUsage, ...(chunk.tokens ? [chunk.tokens] : [])]);
  return {
    ...chunk,
    ...(tokens ? { tokens } : {}),
    ...(tokens?.cost !== undefined ? { cost: tokens.cost } : {}),
  };
}

export class OpencodeProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;
  private readonly useV2: boolean;

  constructor(options?: { retryBaseDelayMs?: number; useV2?: boolean }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.useV2 = options?.useV2 === true;
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

    if (this.useV2) {
      if (hasAgentConfig) {
        throw new Error('OpenCode V2 does not yet support workflow agent definitions');
      }
      if (requestOptions?.outputFormat) {
        throw new Error('OpenCode V2 does not yet support output_format');
      }
      if (requestOptions?.systemPrompt ?? requestOptions?.nodeConfig?.systemPrompt) {
        throw new Error('OpenCode V2 does not yet support system prompt overrides');
      }
      if (requestOptions?.env && Object.keys(requestOptions.env).length > 0) {
        throw new Error('OpenCode V2 does not yet support per-request environment variables');
      }
      if (requestOptions?.nodeConfig?.skills?.length) {
        throw new Error('OpenCode V2 does not yet support workflow skills');
      }
      if (
        requestOptions?.nodeConfig?.allowed_tools?.length ||
        requestOptions?.nodeConfig?.denied_tools?.length
      ) {
        throw new Error('OpenCode V2 does not yet support workflow tool restrictions');
      }
    }

    const sessionCwd =
      hasAgentConfig && nodeId && !usingExternalBaseUrl
        ? join(cwd, '.archon-opencode', nodeId)
        : cwd;

    let lastError: Error | undefined;
    let recoveredAgentNotFound = false;
    const priorV2Usage: TokenUsage[] = [];

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('OpenCode query aborted');
      }

      try {
        if (this.useV2) {
          const runtime = await acquireV2Runtime(
            requestOptions?.abortSignal,
            requestOptions?.nativeTools
          );
          try {
            const { sessionId, resumed } = await resolveSessionIdV2(
              runtime.client,
              cwd,
              resumeSessionId,
              requestOptions?.abortSignal
            );
            if (resumeSessionId && !resumed) {
              yield {
                type: 'system',
                content: '⚠️ Could not resume OpenCode V2 session. Starting fresh conversation.',
              };
            }
            const stream = withResumedOutcome(
              streamOpencodeSessionV2(
                runtime.client,
                cwd,
                sessionId,
                prompt,
                parsedModel,
                requestOptions
              ),
              resumedOutcome(resumeSessionId, resumed)
            );
            for await (const chunk of stream) {
              yield includePriorV2Usage(chunk, priorV2Usage);
            }
            return;
          } finally {
            await runtime.release();
          }
        }

        const runtime = await acquireEmbeddedRuntime(requestOptions?.abortSignal);
        try {
          // V1 path (legacy)
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
            if (!nodeId) {
              throw new Error(
                'OpenCode multi-agent execution requires a nodeId in nodeConfig. ' +
                  'Ensure the workflow node sets nodeConfig.nodeId.'
              );
            }
            // Multi-agent always starts fresh — it resolves its own per-node
            // sessions internally and cannot resume a single prior session. If a
            // resume was requested, report it as cold (false) so the executor
            // surfaces the lost continuity instead of silently starting fresh.
            yield* withResumedOutcome(
              streamMultiAgentOpencodeSession(
                runtime.client,
                sessionCwd,
                nodeId,
                prompt,
                parsedModel,
                requestOptions
              ),
              resumedOutcome(resumeSessionId, false)
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

          yield* withResumedOutcome(
            streamOpencodeSession(
              runtime.client,
              sessionCwd,
              sessionId,
              prompt,
              parsedModel,
              requestOptions
            ),
            resumedOutcome(resumeSessionId, resumed)
          );
          return;
        } finally {
          releaseEmbeddedRuntime(runtime);
        }
      } catch (error) {
        if (error instanceof OpencodeV2RetryableError && error.usage) {
          priorV2Usage.push(error.usage);
        }
        const errorClass = classifyOpencodeError(
          error,
          requestOptions?.abortSignal?.aborted === true
        );
        const enrichedError = enrichOpencodeError(error, errorClass);
        const shouldRetry =
          !requestOptions?.nativeTools?.length &&
          (errorClass === 'rate_limit' ||
            errorClass === 'crash' ||
            (errorClass === 'agent_not_found' && hasAgentConfig && !recoveredAgentNotFound));

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
        if (lastError) {
          enrichedError.cause = lastError;
        }
        lastError = enrichedError;
      }
    }

    throw lastError ?? new Error(`OpenCode query failed after ${MAX_RETRIES} retries`);
  }

  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return getOpencodeCapabilities(this.useV2);
  }
}
