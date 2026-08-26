import { resolve } from 'node:path';

import { createLogger } from '@archon/paths';
import type { OpenCodeClient, OpenCodeEvent, SessionUsageRecorded } from '@opencode-ai/client';

import { mergeTokenUsage } from '../../types';
import type { MessageChunk, SendQueryOptions, TokenUsage } from '../../types';

import { classifyOpencodeError } from './errors';
import { normalizeTokens } from './tokens';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode.v2');
  return cachedLog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSessionNotFound(error: unknown, seen: Set<unknown> = new Set()): boolean {
  if (!isRecord(error) || seen.has(error)) return false;
  seen.add(error);
  if (error._tag === 'SessionNotFoundError' || error.name === 'SessionNotFoundError') return true;
  if (error.status === 404 || error.statusCode === 404) return true;
  return isSessionNotFound(error.cause, seen) || isSessionNotFound(error.data, seen);
}

function sameDirectory(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export async function resolveSessionIdV2(
  client: OpenCodeClient,
  cwd: string,
  resumeSessionId: string | undefined,
  signal?: AbortSignal
): Promise<{ sessionId: string; resumed: boolean }> {
  if (resumeSessionId) {
    try {
      const existing = await client.session.get({ sessionID: resumeSessionId }, { signal });
      if (sameDirectory(existing.location.directory, cwd)) {
        return { sessionId: existing.id, resumed: true };
      }
      getLog().warn(
        { resumeSessionId, cwd, sessionDirectory: existing.location.directory },
        'opencode.v2_session_resume_directory_mismatch'
      );
    } catch (error) {
      if (!isSessionNotFound(error)) throw error;
      getLog().warn({ err: error, resumeSessionId, cwd }, 'opencode.v2_session_resume_failed');
    }
  }

  const created = await client.session.create({ location: { directory: cwd } }, { signal });
  return { sessionId: created.id, resumed: false };
}

type StreamEvent = OpenCodeEvent | SessionUsageRecorded;

function eventSessionId(event: StreamEvent): string | undefined {
  if ('sessionID' in event.data) return event.data.sessionID;
  return event.type === 'form.created' ? event.data.form.sessionID : undefined;
}

function formatToolContent(
  content: readonly (
    | { type: 'text'; text: string }
    | { type: 'file'; uri: string; mime: string; name?: string }
  )[]
): string {
  return content.map(item => (item.type === 'text' ? item.text : JSON.stringify(item))).join('\n');
}

function abortedError(sessionId: string, cwd: string, reason: unknown): Error {
  let detail: string | undefined;
  if (typeof reason === 'string') detail = reason;
  else if (reason instanceof Error) detail = reason.message;
  else if (reason !== undefined && reason !== null) {
    try {
      detail = JSON.stringify(reason);
    } catch {
      detail = 'unknown reason';
    }
  }
  return new Error(
    `OpenCode query aborted (session: ${sessionId}, cwd: ${cwd})` + (detail ? `: ${detail}` : '')
  );
}

function pendingToolResults(
  toolNames: ReadonlyMap<string, string>,
  emittedTools: ReadonlySet<string>,
  completedTools: Set<string>,
  message: string,
  outcome: 'error' | 'interrupted'
): MessageChunk[] {
  return [...emittedTools]
    .filter(toolCallId => !completedTools.has(toolCallId))
    .map(toolCallId => {
      completedTools.add(toolCallId);
      return {
        type: 'tool_result' as const,
        toolName: toolNames.get(toolCallId) ?? 'unknown',
        toolOutput: message,
        toolCallId,
        toolOutcome: outcome,
      };
    });
}

export function summarizeOpencodeV2Usage(usages: readonly TokenUsage[]): TokenUsage | undefined {
  if (usages.length === 0) return undefined;
  if (usages.length === 1) return usages[0];
  const merged = mergeTokenUsage(usages);
  return (
    merged && {
      ...merged,
      total: usages.reduce((sum, usage) => sum + (usage.total ?? usage.input + usage.output), 0),
      cost: usages.reduce((sum, usage) => sum + (usage.cost ?? 0), 0),
    }
  );
}

export class OpencodeV2RetryableError extends Error {
  constructor(
    message: string,
    cause: unknown,
    readonly usage?: TokenUsage
  ) {
    super(message, { cause });
    this.name = 'OpencodeV2RetryableError';
  }
}

export async function* streamOpencodeSessionV2(
  client: OpenCodeClient,
  cwd: string,
  sessionId: string,
  prompt: string,
  model: { providerID: string; modelID: string },
  requestOptions: SendQueryOptions | undefined
): AsyncGenerator<MessageChunk> {
  if (requestOptions?.abortSignal?.aborted) {
    throw abortedError(sessionId, cwd, requestOptions.abortSignal.reason);
  }

  const streamController = new AbortController();
  const signal = requestOptions?.abortSignal
    ? AbortSignal.any([requestOptions.abortSignal, streamController.signal])
    : streamController.signal;
  const iterator = client.event.subscribe({ signal })[Symbol.asyncIterator]();
  const toolNames = new Map<string, string>();
  const emittedTools = new Set<string>();
  const completedTools = new Set<string>();
  const textParts = new Map<string, string>();
  const usages: TokenUsage[] = [];
  let resolvedModel: string | undefined;
  let stopReason: string | undefined;
  let promptSent = false;
  let terminal = false;
  let aborted = false;
  let interruptPromise: Promise<void> | undefined;

  const interrupt = (): Promise<void> => {
    interruptPromise ??= client.session
      .interrupt({ sessionID: sessionId }, { signal: AbortSignal.timeout(5000) })
      .catch(error => {
        getLog().debug({ err: error, sessionId }, 'opencode.v2_session_interrupt_failed');
        streamController.abort(error);
      });
    return interruptPromise;
  };
  const abortHandler = (): void => {
    aborted = true;
    void interrupt();
  };
  requestOptions?.abortSignal?.addEventListener('abort', abortHandler, { once: true });

  try {
    const ready = await iterator.next();
    if (ready.done || ready.value.type !== 'server.connected') {
      throw new Error('OpenCode V2 event stream closed before readiness');
    }

    await client.session.switchModel(
      {
        sessionID: sessionId,
        model: { providerID: model.providerID, id: model.modelID },
      },
      { signal }
    );
    const inbox = await client.session.prompt({ sessionID: sessionId, text: prompt }, { signal });
    promptSent = true;
    let inputDelivered = false;

    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error('OpenCode V2 event stream ended before execution completed');
      // The pinned SDK's EventSubscribeOutput omits this durable event even though
      // its protocol exports SessionUsageRecorded and the daemon emits it.
      const event = next.value as StreamEvent;
      if (eventSessionId(event) !== sessionId) continue;

      if (event.type === 'session.inbox.delivered') {
        if (event.data.inboxID === inbox.id) inputDelivered = true;
        continue;
      }
      if (!inputDelivered) continue;

      if (event.type === 'permission.asked') {
        throw new Error(
          `OpenCode V2 requested interactive permission '${event.data.action}' during a headless Archon run`
        );
      }
      if (event.type === 'form.created') {
        throw new Error(
          `OpenCode V2 requested interactive form '${event.data.form.title}' during a headless Archon run`
        );
      }

      if (event.type === 'session.text.delta') {
        const key = `${event.data.assistantMessageID}:${event.data.ordinal}`;
        textParts.set(key, (textParts.get(key) ?? '') + event.data.delta);
        yield { type: 'assistant', content: event.data.delta };
        continue;
      }
      if (event.type === 'session.text.ended') {
        const key = `${event.data.assistantMessageID}:${event.data.ordinal}`;
        const streamed = textParts.get(key) ?? '';
        if (event.data.text.length > streamed.length && event.data.text.startsWith(streamed)) {
          const tail = event.data.text.slice(streamed.length);
          textParts.set(key, event.data.text);
          yield { type: 'assistant', content: tail };
        } else if (event.data.text !== streamed) {
          getLog().warn(
            {
              sessionId,
              assistantMessageId: event.data.assistantMessageID,
              ordinal: event.data.ordinal,
              streamedLength: streamed.length,
              finalLength: event.data.text.length,
            },
            'opencode.v2_text_ended_diverged_from_deltas'
          );
        }
        continue;
      }
      if (event.type === 'session.reasoning.delta') {
        yield { type: 'thinking', content: event.data.delta };
        continue;
      }
      if (event.type === 'session.tool.input.started') {
        toolNames.set(event.data.id, event.data.name);
        continue;
      }
      if (event.type === 'session.tool.called') {
        if (!emittedTools.has(event.data.id)) {
          emittedTools.add(event.data.id);
          yield {
            type: 'tool',
            toolName: toolNames.get(event.data.id) ?? 'unknown',
            toolInput: event.data.input,
            toolCallId: event.data.id,
          };
        }
        continue;
      }
      if (event.type === 'session.tool.success') {
        if (!completedTools.has(event.data.id)) {
          completedTools.add(event.data.id);
          yield {
            type: 'tool_result',
            toolName: toolNames.get(event.data.id) ?? 'unknown',
            toolOutput: formatToolContent(event.data.content),
            toolCallId: event.data.id,
            toolOutcome: 'success',
          };
        }
        continue;
      }
      if (event.type === 'session.tool.failed') {
        if (!completedTools.has(event.data.id)) {
          completedTools.add(event.data.id);
          yield {
            type: 'tool_result',
            toolName: toolNames.get(event.data.id) ?? 'unknown',
            toolOutput: event.data.error.message,
            toolCallId: event.data.id,
            toolOutcome: 'error',
          };
        }
        continue;
      }
      if (event.type === 'session.step.started') {
        resolvedModel = event.data.model.id;
        continue;
      }
      if (event.type === 'session.step.ended') {
        stopReason = event.data.finish;
        const usage = normalizeTokens({ tokens: event.data.tokens, cost: event.data.cost });
        if (usage) usages.push(usage);
        continue;
      }
      if (event.type === 'session.step.failed') {
        stopReason = event.data.finish ?? event.data.rawFinish;
        if (event.data.tokens) {
          const usage = normalizeTokens({
            tokens: event.data.tokens,
            ...(event.data.cost !== undefined ? { cost: event.data.cost } : {}),
          });
          if (usage) usages.push(usage);
        }
        yield* pendingToolResults(
          toolNames,
          emittedTools,
          completedTools,
          event.data.error.message,
          'error'
        );
        continue;
      }
      if (event.type === 'session.usage.recorded') {
        const usage = normalizeTokens({ tokens: event.data.tokens, cost: event.data.cost });
        if (usage) usages.push(usage);
        continue;
      }
      if (event.type === 'session.execution.failed') {
        terminal = true;
        yield* pendingToolResults(
          toolNames,
          emittedTools,
          completedTools,
          event.data.error.message,
          'error'
        );
        const errorClass = classifyOpencodeError(event.data.error, false);
        const usage = summarizeOpencodeV2Usage(usages);
        if (errorClass === 'rate_limit' || errorClass === 'crash') {
          throw new OpencodeV2RetryableError(event.data.error.message, event.data.error, usage);
        }
        yield {
          type: 'result',
          sessionId,
          isError: true,
          errorSubtype: 'opencode_execution_failed',
          errors: [event.data.error.message],
          ...(usage ? { tokens: usage, cost: usage.cost } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(resolvedModel ? { resolvedModel: { id: resolvedModel } } : {}),
        };
        return;
      }
      if (event.type === 'session.execution.interrupted') {
        terminal = true;
        yield* pendingToolResults(
          toolNames,
          emittedTools,
          completedTools,
          `OpenCode execution interrupted: ${event.data.reason}`,
          'interrupted'
        );
        if (aborted || requestOptions?.abortSignal?.aborted) {
          throw abortedError(sessionId, cwd, requestOptions?.abortSignal?.reason);
        }
        throw new Error(`OpenCode execution interrupted: ${event.data.reason}`);
      }
      if (event.type === 'session.execution.succeeded') {
        terminal = true;
        const usage = summarizeOpencodeV2Usage(usages);
        yield {
          type: 'result',
          sessionId,
          ...(usage ? { tokens: usage, cost: usage.cost } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(resolvedModel ? { resolvedModel: { id: resolvedModel } } : {}),
        };
        return;
      }
    }
  } catch (error) {
    if (aborted || requestOptions?.abortSignal?.aborted) {
      throw abortedError(sessionId, cwd, requestOptions?.abortSignal?.reason);
    }
    throw error;
  } finally {
    requestOptions?.abortSignal?.removeEventListener('abort', abortHandler);
    if (promptSent && !terminal) await interrupt();
    else if (interruptPromise) await interruptPromise;
    streamController.abort();
    try {
      await iterator.return?.();
    } catch (error) {
      getLog().debug({ err: error, sessionId }, 'opencode.v2_event_stream_close_failed');
    }
  }
}
