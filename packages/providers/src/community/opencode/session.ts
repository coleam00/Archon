import { createLogger } from '@archon/paths';

import { truncateToolOutput, type ProviderStopReason } from '@archon/provider-contract';

import type { MessageChunk, ResultChunk, SendQueryOptions } from '../../types';

import {
  adaptNamedAgentForOpencode,
  resolvePromptForAgent,
  selectSingleAgent,
  type NamedAgentConfig,
} from './agent-config';
import { errorMessage, pendingPermissionError } from './errors';
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

type TextBlock = Extract<MessageChunk, { type: 'agent_message_chunk' | 'agent_thought_chunk' }>;

/**
 * OpenCode updates one text or reasoning part many times as it grows. The contract
 * carries a whole block, so a part becomes one chunk when OpenCode marks it finished
 * (`time.end`); `drain()` returns the parts still open when the turn ends.
 */
export class TextPartBlocks {
  private readonly open = new Map<string, TextBlock>();
  private readonly finished = new Set<string>();

  /** Records one `message.part.updated` of a text or reasoning part; returns the block once it is finished. */
  update(part: Record<string, unknown>, delta: string | undefined): TextBlock | undefined {
    if (typeof part.id !== 'string' || this.finished.has(part.id)) return undefined;
    const type = part.type === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk';
    const text =
      typeof part.text === 'string'
        ? part.text
        : (this.open.get(part.id)?.text ?? '') + (delta ?? '');
    if (!(isRecord(part.time) && typeof part.time.end === 'number')) {
      this.open.set(part.id, { type, text });
      return undefined;
    }
    this.open.delete(part.id);
    this.finished.add(part.id);
    return text ? { type, text } : undefined;
  }

  drain(): TextBlock[] {
    const blocks = [...this.open.values()].filter(block => block.text);
    this.open.clear();
    return blocks;
  }
}

/**
 * The tool events one `message.part.updated` of a tool part adds: the `tool_call` the
 * first time `toolCallId` is seen, and the `tool_call_update` once the part reaches
 * `completed` or `error`. `seen` and `closed` carry that state across updates.
 */
export function toolPartEvents(
  part: Record<string, unknown>,
  toolCallId: string,
  seen: Set<string>,
  closed: Set<string>
): MessageChunk[] {
  const events: MessageChunk[] = [];
  const state = isRecord(part.state) ? part.state : undefined;
  if (!seen.has(toolCallId)) {
    seen.add(toolCallId);
    const call: MessageChunk = {
      type: 'tool_call',
      toolCallId,
      name: typeof part.tool === 'string' ? part.tool : 'unknown',
    };
    if (isRecord(state?.input)) call.rawInput = state.input;
    events.push(call);
  }
  if (!closed.has(toolCallId)) {
    if (state?.status === 'completed') {
      closed.add(toolCallId);
      events.push({
        type: 'tool_call_update',
        toolCallId,
        status: 'completed',
        ...truncateToolOutput(typeof state.output === 'string' ? state.output : ''),
      });
    } else if (state?.status === 'error') {
      closed.add(toolCallId);
      events.push({
        type: 'tool_call_update',
        toolCallId,
        status: 'failed',
        ...truncateToolOutput(typeof state.error === 'string' ? state.error : 'Tool failed'),
      });
    }
  }
  return events;
}

/** OpenCode's `finish` reason in ACP's names; `undefined` for one ACP has no name for. */
function opencodeStopReason(finish: unknown): ProviderStopReason | undefined {
  if (finish === 'stop') return 'end_turn';
  if (finish === 'length') return 'max_tokens';
  // ACP has no name for it; the native value stays in the log.
  if (finish !== undefined) getLog().debug({ finish }, 'opencode.stop_reason_unmapped');
  return undefined;
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
  await client.session.promptAsync({
    path: { id: sessionId },
    query: { directory: cwd },
    body: promptBody,
  });
}

async function readStructuredOutput(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  messageId: string | undefined
): Promise<unknown> {
  if (!messageId) return undefined;

  try {
    const response = await client.session.message({
      path: { id: sessionId, messageID: messageId },
      query: { directory: cwd },
    });
    const info = response.data?.info;
    if (isRecord(info) && 'structured_output' in info) {
      return info.structured_output;
    }
  } catch (error) {
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
  const events = await client.event.subscribe({ query: { directory: cwd } });
  const streamController = new AbortController();
  const seenToolCalls = new Set<string>();
  const completedToolCalls = new Set<string>();
  const textBlocks = new TextPartBlocks();
  let latestAssistantInfo: Record<string, unknown> | undefined;
  let lastAssistantMessageId: string | undefined;
  let aborted = requestOptions?.abortSignal?.aborted === true;

  const abortHandler = (): void => {
    aborted = true;
    void client.session
      .abort({ path: { id: sessionId }, query: { directory: cwd } })
      .catch((error): void => {
        getLog().debug({ err: error, sessionId }, 'opencode.session_abort_failed');
      });
    streamController.abort();
  };

  requestOptions?.abortSignal?.addEventListener('abort', abortHandler, {
    once: true,
  });

  try {
    const promptBody = createSessionPromptBody(prompt, model, requestOptions);
    await promptSession(client, cwd, sessionId, promptBody);

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

        if (part.type === 'text' || part.type === 'reasoning') {
          const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
          const block = textBlocks.update(part, delta);
          if (block) yield block;
          continue;
        }

        if (part.type === 'tool' && typeof part.callID === 'string') {
          yield* toolPartEvents(part, part.callID, seenToolCalls, completedToolCalls);
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
        throw err;
      }

      // The embedded server (runtime.ts) sets no `permission` policy of its
      // own, so this fires whenever the user's own OpenCode config (or an
      // upstream default, e.g. `doom_loop`/`external_directory`, which
      // default to `ask`) leaves a category unresolved. Workflow nodes run
      // unattended, so nobody can answer that prompt: fail the node fast
      // rather than hang forever waiting for a `session.idle` that will
      // never arrive while the session is permission-blocked (issue #3332).
      // `properties` for this event *is* the pending-permission record
      // itself (unlike `session.error`, whose `sessionID` sits inside
      // `properties`). The real event is `permission.asked`, not the
      // `permission.updated` name the `@opencode-ai/sdk` npm package's
      // types declare — verified against a live server's `EventPermissionAsked`
      // schema (`GET /doc`); the pinned SDK's types are stale for this event.
      if (event.type === 'permission.asked') {
        const eventSessionId =
          typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
        if (eventSessionId && eventSessionId !== sessionId) continue;

        throw pendingPermissionError(properties);
      }

      if (event.type === 'session.idle') {
        if (properties.sessionID !== sessionId) continue;

        const structuredOutput = await readStructuredOutput(
          client,
          cwd,
          sessionId,
          lastAssistantMessageId
        );
        const tokens = normalizeTokens(latestAssistantInfo);

        yield* textBlocks.drain();
        // Built by assignment on a typed value so a misspelled key fails to compile.
        const result: ResultChunk = { type: 'result', sessionId };
        if (tokens) result.tokens = tokens;
        if (structuredOutput !== undefined) result.structuredOutput = structuredOutput;
        if (typeof latestAssistantInfo?.cost === 'number') result.cost = latestAssistantInfo.cost;
        const stopReason = opencodeStopReason(latestAssistantInfo?.finish);
        if (stopReason !== undefined) result.stopReason = stopReason;
        if (typeof latestAssistantInfo?.modelID === 'string' && latestAssistantInfo.modelID) {
          result.resolvedModel = { id: latestAssistantInfo.modelID };
        }
        yield result;
        return;
      }
    }

    if (aborted) {
      const abortReason = requestOptions?.abortSignal?.reason;
      throw new Error(
        `OpenCode query aborted (session: ${sessionId}, cwd: ${cwd})` +
          (abortReason ? `: ${String(abortReason)}` : '')
      );
    }
    // Only `session.idle` reports the turn's outcome. A stream that closed before it
    // (the embedded server died or dropped the connection) is a failed turn, not an
    // empty success.
    throw new Error(`OpenCode event stream ended before session.idle (session: ${sessionId})`);
  } catch (error) {
    // Preserve partial output: a part still open when the turn fails reaches the user.
    yield* textBlocks.drain();
    throw error;
  } finally {
    requestOptions?.abortSignal?.removeEventListener('abort', abortHandler);
    streamController.abort();
  }
}

export async function* abortableStream(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal
): AsyncGenerator<unknown, void, unknown> {
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    if (signal.aborted) {
      await iterator.return?.().catch(() => undefined);
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
      await iterator.return?.().catch(() => undefined);
      return;
    }
    yield result.value;
  }
}
