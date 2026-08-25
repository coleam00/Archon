import { createLogger } from '@archon/paths';

import type { MessageChunk, SendQueryOptions } from '../../types';
import {
  confirmProviderAttemptStopped,
  ProviderAttemptStopUnconfirmedError,
  waitForPromiseOrAbort,
} from '../../shared/provider-attempt';

import {
  adaptNamedAgentForOpencode,
  resolvePromptForAgent,
  selectSingleAgent,
  type NamedAgentConfig,
} from './agent-config';
import { errorMessage } from './errors';
import type { OpencodeClientLike } from './runtime';
import { normalizeTokens } from './tokens';

let cachedLog: ReturnType<typeof createLogger> | undefined;

function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function resolveSessionId(
  client: OpencodeClientLike,
  cwd: string,
  resumeSessionId: string | undefined
): Promise<{ sessionId: string; resumed: boolean }> {
  if (resumeSessionId) {
    try {
      const existing = await client.session.get({
        path: { id: resumeSessionId },
        query: { directory: cwd },
      });
      const sessionId = existing.data?.id;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        return { sessionId, resumed: true };
      }
    } catch (error) {
      getLog().warn({ err: error, resumeSessionId, cwd }, 'opencode.session_resume_failed');
    }
  }

  const created = await client.session.create({ query: { directory: cwd } });
  const sessionId = created.data?.id;
  if (!sessionId) {
    throw new Error('OpenCode failed to create a session');
  }

  return { sessionId, resumed: false };
}

export function createSessionPromptBody(
  prompt: string,
  model: { providerID: string; modelID: string },
  requestOptions: SendQueryOptions | undefined,
  agentOverride?: NamedAgentConfig
): Record<string, unknown> {
  const singleAgent = agentOverride ?? selectSingleAgent(requestOptions?.nodeConfig?.agents);
  const adaptedAgentConfig = singleAgent ? adaptNamedAgentForOpencode(singleAgent) : undefined;
  const effectivePrompt = resolvePromptForAgent(singleAgent, prompt);
  const promptBody: Record<string, unknown> = {
    parts: [{ type: 'text', text: effectivePrompt }],
    model: adaptedAgentConfig?.model ?? model,
    ...(adaptedAgentConfig?.agent ? { agent: adaptedAgentConfig.agent } : {}),
    ...(adaptedAgentConfig?.tools ? { tools: adaptedAgentConfig.tools } : {}),
    ...(requestOptions?.systemPrompt ? { system: requestOptions.systemPrompt } : {}),
  };

  if (requestOptions?.outputFormat?.type === 'json_schema') {
    promptBody.format = {
      type: 'json_schema',
      schema: requestOptions.outputFormat.schema,
    };
  }

  return promptBody;
}

export async function promptSession(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  promptBody: Record<string, unknown>
): Promise<void> {
  const response = await client.session.promptAsync({
    path: { id: sessionId },
    query: { directory: cwd },
    body: promptBody,
    throwOnError: true,
  });
  if (response?.error !== undefined) {
    throw new Error(`OpenCode rejected prompt submission (session: ${sessionId}, cwd: ${cwd})`);
  }
}

export async function abortOpencodeSession(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string
): Promise<void> {
  const response = await client.session.abort({
    path: { id: sessionId },
    query: { directory: cwd },
    throwOnError: true,
  });
  if (response.error !== undefined || response.data !== true) {
    throw new Error(`OpenCode rejected session abort (session: ${sessionId}, cwd: ${cwd})`);
  }
}

async function readStructuredOutput(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  messageId: string | undefined,
  requestSignal: AbortSignal | undefined
): Promise<unknown> {
  if (!messageId) return undefined;

  try {
    const timeoutSignal = AbortSignal.timeout(5_000);
    const lookupSignal = requestSignal
      ? AbortSignal.any([requestSignal, timeoutSignal])
      : timeoutSignal;
    const response = await waitForPromiseOrAbort(
      client.session.message({
        path: { id: sessionId, messageID: messageId },
        query: { directory: cwd },
      }),
      lookupSignal
    );
    const info = response.data?.info;
    if (isRecord(info) && 'structured_output' in info) {
      return info.structured_output;
    }
  } catch (error) {
    if (requestSignal?.aborted) requestSignal.throwIfAborted();
    getLog().warn({ err: error, sessionId, messageId }, 'opencode.structured_output_lookup_failed');
  }

  return undefined;
}

export async function* streamOpencodeSession(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  prompt: string,
  model: { providerID: string; modelID: string },
  requestOptions: SendQueryOptions | undefined
): AsyncGenerator<MessageChunk> {
  const streamController = new AbortController();
  const seenToolCalls = new Set<string>();
  const completedToolCalls = new Set<string>();
  let latestAssistantInfo: Record<string, unknown> | undefined;
  let lastAssistantMessageId: string | undefined;
  let aborted = requestOptions?.abortSignal?.aborted === true;
  let terminalObserved = false;
  let promptSettled = false;
  let promptPendingAfterAbort = false;
  let preSubmissionAbortPromise: Promise<void> | undefined;
  let postSubmissionAbortPromise: Promise<void> | undefined;

  const abortSession = (): Promise<void> => {
    const existingAbort = promptSettled ? postSubmissionAbortPromise : preSubmissionAbortPromise;
    if (existingAbort) return existingAbort;

    const abortPromise = abortOpencodeSession(client, cwd, sessionId);
    if (promptSettled) postSubmissionAbortPromise = abortPromise;
    else preSubmissionAbortPromise = abortPromise;
    void abortPromise.catch((error): void => {
      getLog().debug({ err: error, sessionId }, 'opencode.session_abort_failed');
    });
    return abortPromise;
  };

  const confirmSessionStopped = async (): Promise<void> => {
    await confirmProviderAttemptStopped(
      abortSession,
      `OpenCode session shutdown could not be confirmed (session: ${sessionId}, cwd: ${cwd})`
    );
  };

  const abortHandler = (): void => {
    aborted = true;
    void abortSession();
    streamController.abort();
  };

  requestOptions?.abortSignal?.addEventListener('abort', abortHandler, {
    once: true,
  });

  try {
    const events = await waitForPromiseOrAbort(
      client.event.subscribe({ query: { directory: cwd } }),
      requestOptions?.abortSignal
    );
    requestOptions?.abortSignal?.throwIfAborted();
    const promptBody = createSessionPromptBody(prompt, model, requestOptions);
    const promptPromise = promptSession(client, cwd, sessionId, promptBody).finally((): void => {
      // An abort accepted before promptAsync settles cannot prove that work accepted
      // afterward was stopped. Cleanup must confirm cancellation again from this point.
      promptSettled = true;
    });
    try {
      await waitForPromiseOrAbort(promptPromise, requestOptions?.abortSignal);
    } catch (error) {
      if (requestOptions?.abortSignal?.aborted && !promptSettled) {
        promptPendingAfterAbort = true;
        // The lease must expire instead of renewing forever, but a submission that
        // eventually settles still gets a best-effort post-submission abort.
        void promptPromise.then(confirmSessionStopped, confirmSessionStopped).catch(abortError => {
          getLog().debug({ err: abortError, sessionId }, 'opencode.late_session_abort_failed');
        });
        throw new ProviderAttemptStopUnconfirmedError(
          `OpenCode prompt submission did not settle after cancellation (session: ${sessionId}, cwd: ${cwd})`,
          { cause: error }
        );
      }
      throw error;
    }

    for await (const rawEvent of abortableStream(events.stream, streamController.signal)) {
      const event = rawEvent as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      const properties = isRecord(event.properties) ? event.properties : {};

      if (event.type === 'message.updated') {
        const info = isRecord(properties.info) ? properties.info : undefined;
        if (info?.role === 'assistant' && info.sessionID === sessionId) {
          latestAssistantInfo = info;
          if (typeof info.id === 'string') {
            lastAssistantMessageId = info.id;
          }
        }
        continue;
      }

      if (event.type === 'message.part.updated') {
        const part = isRecord(properties.part) ? properties.part : undefined;
        if (!part || part?.sessionID !== sessionId || typeof part.type !== 'string') {
          continue;
        }

        if (part.type === 'text') {
          const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
          const text = delta ?? (typeof part.text === 'string' ? part.text : '');
          if (text) {
            yield { type: 'assistant', content: text };
          }
          continue;
        }

        if (part.type === 'reasoning') {
          const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
          const text = delta ?? (typeof part.text === 'string' ? part.text : '');
          if (text) {
            yield { type: 'thinking', content: text };
          }
          continue;
        }

        if (part.type === 'tool') {
          const callId = typeof part.callID === 'string' ? part.callID : undefined;
          const toolName = typeof part.tool === 'string' ? part.tool : 'unknown';
          const state = isRecord(part.state) ? part.state : undefined;
          const toolInput = isRecord(state?.input) ? state.input : undefined;
          const status = typeof state?.status === 'string' ? state.status : undefined;

          if (callId && !seenToolCalls.has(callId)) {
            seenToolCalls.add(callId);
            yield {
              type: 'tool',
              toolName,
              ...(toolInput ? { toolInput } : {}),
              ...(callId ? { toolCallId: callId } : {}),
            };
          }

          if (callId && !completedToolCalls.has(callId)) {
            if (status === 'completed') {
              completedToolCalls.add(callId);
              yield {
                type: 'tool_result',
                toolName,
                toolOutput: typeof state?.output === 'string' ? state.output : '',
                ...(callId ? { toolCallId: callId } : {}),
                toolOutcome: 'success',
              };
            } else if (status === 'error') {
              completedToolCalls.add(callId);
              yield {
                type: 'tool_result',
                toolName,
                toolOutput: typeof state?.error === 'string' ? state.error : 'Tool failed',
                ...(callId ? { toolCallId: callId } : {}),
                toolOutcome: 'error',
              };
            }
          }
        }
        continue;
      }

      if (event.type === 'session.error') {
        const eventSessionId =
          typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
        if (eventSessionId && eventSessionId !== sessionId) continue;

        const rawError = isRecord(properties.error) ? properties.error : properties;
        const err = new Error(errorMessage(rawError));
        err.cause = rawError;
        terminalObserved = true;
        throw err;
      }

      if (event.type === 'session.idle') {
        if (properties.sessionID !== sessionId) continue;

        const structuredOutput = await readStructuredOutput(
          client,
          cwd,
          sessionId,
          lastAssistantMessageId,
          requestOptions?.abortSignal
        );
        const tokens = normalizeTokens(latestAssistantInfo);
        terminalObserved = true;

        yield {
          type: 'result',
          sessionId,
          ...(tokens ? { tokens } : {}),
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
          ...(typeof latestAssistantInfo?.cost === 'number'
            ? { cost: latestAssistantInfo.cost }
            : {}),
          ...(typeof latestAssistantInfo?.finish === 'string'
            ? { stopReason: latestAssistantInfo.finish }
            : {}),
          ...(typeof latestAssistantInfo?.modelID === 'string' &&
          latestAssistantInfo.modelID.length > 0
            ? { resolvedModel: { id: latestAssistantInfo.modelID } }
            : {}),
        };
        return;
      }
    }

    if (!terminalObserved && !aborted) {
      throw new Error(
        `OpenCode event stream ended before session became idle (session: ${sessionId}, cwd: ${cwd})`
      );
    }

    if (aborted) {
      const abortReason = requestOptions?.abortSignal?.reason;
      throw new Error(
        `OpenCode query aborted (session: ${sessionId}, cwd: ${cwd})` +
          (abortReason ? `: ${String(abortReason)}` : '')
      );
    }
  } finally {
    requestOptions?.abortSignal?.removeEventListener('abort', abortHandler);
    streamController.abort();
    if (!terminalObserved && !promptPendingAfterAbort) await confirmSessionStopped();
  }
}

export async function* abortableStream(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal
): AsyncGenerator<unknown, void, unknown> {
  const iterator = stream[Symbol.asyncIterator]();
  const closeIterator = (): void => {
    try {
      void iterator.return?.().catch(() => undefined);
    } catch {
      // The provider session abort is the authoritative shutdown boundary.
    }
  };

  while (true) {
    if (signal.aborted) {
      closeIterator();
      return;
    }

    const nextPromise = iterator.next();
    const result = await Promise.race([
      nextPromise,
      new Promise<IteratorResult<unknown>>(resolve => {
        const onAbort = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve({ done: true, value: undefined });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void nextPromise.finally((): void => {
          signal.removeEventListener('abort', onAbort);
        });
      }),
    ]);

    if (result.done) {
      closeIterator();
      return;
    }
    yield result.value;
  }
}
