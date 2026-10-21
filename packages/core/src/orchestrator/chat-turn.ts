/**
 * One direct-chat turn: send the prompt to the provider, stream or batch its reply, and
 * report its telemetry through `reportChatTurn`.
 */
import { captureChatTurn } from '@archon/paths';
import type { IPlatformAdapter, Conversation } from '../types';
import type { ResultChunk, SendQueryOptions, TokenUsage } from '@archon/providers/types';
import {
  addResultUsage,
  sessionPreview,
  toolCallDisplayName,
  type ResultUsageTotal,
} from '@archon/provider-contract';
import * as sessionDb from '../db/sessions';
import { formatToolCall } from '@archon/workflows/utils/tool-formatter';
import { classifyAndFormatError, formatProviderFailure } from '../utils/error-formatter';
import { toError } from '../utils/error';
import type { getAgentProvider } from '../services/provider-admission';
import type { WorkflowCommandSurface } from '@archon/workflows/deps';
import { getLog } from './agent-log';
import * as messageDb from '../db/messages';
import { filterToolIndicators, shiftReplyChunk, type ReplyChunk } from './batch-reply';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max assistant text chunks to keep in batch mode (oldest are dropped) */
const MAX_BATCH_ASSISTANT_CHUNKS = 20;
/** Max total chunks (assistant + tool) to keep in batch mode */
const MAX_BATCH_TOTAL_CHUNKS = 200;

// ─── Session Helpers ────────────────────────────────────────────────────────

async function tryPersistSessionId(
  sessionId: string,
  assistantSessionId: string | null
): Promise<void> {
  try {
    await sessionDb.updateSession(sessionId, assistantSessionId);
  } catch (error) {
    getLog().error(
      {
        err: error as Error,
        sessionId,
        ...(assistantSessionId
          ? { persistedValuePreview: sessionPreview(assistantSessionId) }
          : {}),
      },
      'session_id_persist_failed'
    );
  }
}

/**
 * One direct-chat turn's telemetry state. Every `chat_turn_handled` for the turn goes
 * through {@link reportChatTurn}, so the dispatcher's failure report can tell whether a
 * mode handler already reported and never counts one turn twice.
 */
export interface ChatTurn {
  readonly startedAt: number;
  reported: boolean;
  result?: TurnResult;
  /** A failed turn drops any launch queued during it. */
  failed: boolean;
}

/**
 * The chat message for a failed turn's result. The provider's typed failure decides the
 * advice, as it decides retry in the workflow engine. A result without one comes from a
 * provider that does not report `failure` yet; its subtype and SDK detail still go
 * through credential redaction and are shown as diagnostics without inferred advice.
 */
function resultFailureMessage(msg: ResultChunk, surface: WorkflowCommandSurface): string {
  if (msg.failure !== undefined) return formatProviderFailure(msg.failure);
  const errorDetail = [msg.errorSubtype, ...(msg.errors ?? [])].filter(Boolean).join(': ');
  return classifyAndFormatError(new Error(errorDetail || 'AI result error'), surface);
}

export function reportChatTurn(
  turn: ChatTurn,
  props: Omit<Parameters<typeof captureChatTurn>[0], 'costUsd' | 'tokensIn' | 'tokensOut'>
): void {
  turn.reported = true;
  turn.failed = props.outcome === 'failed';
  captureChatTurn({
    ...props,
    costUsd: turn.result?.cost,
    tokensIn: turn.result?.tokens?.input,
    tokensOut: turn.result?.tokens?.output,
  });
}

/** Everything one chat turn's mode handler reads, built once by `handleMessage`. */
export interface ChatTurnInput {
  readonly turn: ChatTurn;
  readonly platform: IPlatformAdapter;
  readonly conversationId: string;
  readonly aiClient: ReturnType<typeof getAgentProvider>;
  readonly fullPrompt: string;
  readonly cwd: string;
  readonly session: { id: string; assistant_session_id: string | null };
  readonly conversation: Conversation;
  readonly requestOptions: SendQueryOptions;
}

/** Usage summed over every `result` chunk of the turn, as the workflow engine sums a node. */
type TurnResult = ResultUsageTotal & { stopReason?: string };

/**
 * The provider session id to persist after a `result` chunk. An `error_during_execution`
 * result clears the stored id, which the provider can no longer resume.
 */
async function sessionIdAfterResult(
  input: ChatTurnInput,
  msg: ResultChunk,
  current: string | undefined
): Promise<string | undefined> {
  if (msg.isError && msg.errorSubtype === 'error_during_execution') {
    getLog().warn(
      {
        conversationId: input.conversationId,
        errorSubtype: msg.errorSubtype,
        ...(msg.sessionId ? { staleSessionIdPreview: sessionPreview(msg.sessionId) } : {}),
        errors: msg.errors,
        stopReason: msg.stopReason,
      },
      'clearing_stale_session_id'
    );
    await tryPersistSessionId(input.session.id, null);
    return undefined;
  }
  if (msg.sessionId) return msg.sessionId;
  return current;
}

/**
 * When the `result` chunk is a failure, tell the user, persist the session and report the
 * failed turn. Returns whether it was one; the turn then ends.
 */
async function reportFailedResult(
  input: ChatTurnInput,
  msg: ResultChunk,
  newSessionId: string | undefined
): Promise<boolean> {
  // Defense-in-depth: errorSubtype === 'success' is the Claude SDK's marker
  // for a clean stop_sequence termination (the SDK sets is_error: true
  // alongside subtype: 'success' to encode "non-default termination, not a
  // failure"). The Claude provider already filters this; the guard here
  // defends against a third-party IAgentProvider that forwards the SDK
  // pair raw — without it, direct chat would surface a spurious error to
  // the user and drop the actual conversation output.
  const failed = msg.failure !== undefined || (msg.isError && msg.errorSubtype !== 'success');
  if (!failed) return false;
  const { turn, platform, conversationId, aiClient, session, requestOptions } = input;
  getLog().warn(
    {
      conversationId,
      errorSubtype: msg.errorSubtype,
      failureClass: msg.failure?.class,
      errors: msg.errors,
      stopReason: msg.stopReason,
    },
    'ai_result_error'
  );
  await platform.sendMessage(conversationId, resultFailureMessage(msg, platform));
  if (newSessionId) {
    await tryPersistSessionId(session.id, newSessionId);
  }
  // Anonymous telemetry: AI returned an error result for this chat turn.
  reportChatTurn(turn, {
    platform: platform.getPlatformType(),
    provider: aiClient.getType(),
    model: requestOptions.model,
    durationMs: Date.now() - turn.startedAt,
    outcome: 'failed',
  });
  return true;
}

/** Persist the reply, send the result footer and report the completed turn. */
async function completeChatTurn(input: ChatTurnInput, text: string): Promise<void> {
  const { turn, platform, conversationId, conversation, aiClient, requestOptions } = input;
  // Adapter-owned storage must not get a second copy of the assistant reply (#1182).
  if (platform.capabilities.messagePersistence === 'core' && text) {
    messageDb.addMessage(conversation.id, 'assistant', text).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      getLog().warn(
        { err, errorType: err.constructor.name, conversationId },
        'orchestrator.assistant_message_persist_failed'
      );
    });
  }
  await maybeSendResultFooter(platform, conversationId, turn.result);
  reportChatTurn(turn, {
    platform: platform.getPlatformType(),
    provider: aiClient.getType(),
    model: requestOptions.model,
    // durationMs deliberately measures from mode-handler entry — it includes
    // pre-AI setup, i.e. "time the user waited", not pure model latency.
    durationMs: Date.now() - turn.startedAt,
    outcome: 'completed',
  });
}

async function reportUnansweredToolFailure(input: ChatTurnInput): Promise<void> {
  const { platform, conversationId, aiClient, requestOptions, turn } = input;
  await platform.sendMessage(
    conversationId,
    'A tool failed or was cancelled, and the assistant returned no follow-up reply. The requested action may not have completed. Check the run status before retrying.'
  );
  await maybeSendResultFooter(platform, conversationId, turn.result);
  reportChatTurn(turn, {
    platform: platform.getPlatformType(),
    provider: aiClient.getType(),
    model: requestOptions.model,
    durationMs: Date.now() - turn.startedAt,
    outcome: 'failed',
  });
}

// ─── Streaming Mode ─────────────────────────────────────────────────────────

/**
 * Stream mode: send text chunks immediately for real-time UX (web, Telegram stream).
 */
export async function handleStreamMode(input: ChatTurnInput): Promise<void> {
  const { turn, platform, conversationId, aiClient, fullPrompt, cwd, session } = input;
  const allMessages: string[] = [];
  let newSessionId: string | undefined;
  let toolFailed = false;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    input.requestOptions
  )) {
    if (msg.type === 'agent_message_chunk') {
      if (msg.text.trim()) toolFailed = false;
      allMessages.push(msg.text);
      await platform.sendMessage(conversationId, msg.text);
    } else if (msg.type === 'tool_call') {
      const toolMessage = formatToolCall(toolCallDisplayName(msg), msg.rawInput);
      await platform.sendMessage(conversationId, toolMessage, {
        category: 'tool_call_formatted',
      });
      if (platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
    } else if (msg.type === 'tool_call_update') {
      toolFailed ||= msg.status === 'failed' || msg.status === 'cancelled';
      if (platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
    } else if (msg.type === 'warning') {
      await platform.sendMessage(conversationId, `⚠️ ${msg.message}`);
    } else if (msg.type === 'result') {
      turn.result = {
        ...addResultUsage(turn.result ?? {}, msg),
        stopReason: msg.stopReason ?? turn.result?.stopReason,
      };
      newSessionId = await sessionIdAfterResult(input, msg, newSessionId);
      if (await reportFailedResult(input, msg, newSessionId)) return;
      if (platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
    }
  }

  if (newSessionId) {
    await tryPersistSessionId(session.id, newSessionId);
  }

  if (toolFailed) return reportUnansweredToolFailure(input);

  if (allMessages.length === 0) {
    // Intentionally NOT counted in chat_turn_handled — an empty response is
    // neither a completed nor a failed turn worth measuring.
    getLog().debug({ conversationId }, 'no_ai_response');
    return;
  }

  const fullResponse = allMessages.join('');
  // Text was already streamed — nothing more to send.
  await completeChatTurn(input, fullResponse);
}

// ─── Batch Mode ─────────────────────────────────────────────────────────────

/**
 * Batch mode: accumulate chunks and filter tool indicators, falling back to the originals.
 * Used by Slack, GitHub, Discord (batch), and CLI.
 */
export async function handleBatchMode(input: ChatTurnInput): Promise<void> {
  const { turn, platform, conversationId, aiClient, fullPrompt, cwd, session } = input;
  const allChunks: { type: string; content: string }[] = [];
  const assistantMessages: ReplyChunk[] = [];
  let assistantChunksTruncated = false;
  let totalChunksTruncated = false;
  let newSessionId: string | undefined;
  let toolFailed = false;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined,
    input.requestOptions
  )) {
    if (msg.type === 'agent_message_chunk') {
      if (msg.text.trim()) toolFailed = false;
      allChunks.push({ type: 'assistant', content: msg.text });
      assistantMessages.push(msg);
      if (assistantMessages.length > MAX_BATCH_ASSISTANT_CHUNKS) {
        shiftReplyChunk(assistantMessages);
        assistantChunksTruncated = true;
      }
    } else if (msg.type === 'tool_call') {
      const toolMessage = formatToolCall(toolCallDisplayName(msg), msg.rawInput);
      allChunks.push({ type: 'tool', content: toolMessage });
      getLog().debug({ toolName: msg.name }, 'tool_call');
    } else if (msg.type === 'tool_call_update') {
      toolFailed ||= msg.status === 'failed' || msg.status === 'cancelled';
    } else if (msg.type === 'warning') {
      // A warning surfaces as it arrives, not batched into the reply.
      await platform.sendMessage(conversationId, `⚠️ ${msg.message}`);
    } else if (msg.type === 'result') {
      turn.result = {
        ...addResultUsage(turn.result ?? {}, msg),
        stopReason: msg.stopReason ?? turn.result?.stopReason,
      };
      newSessionId = await sessionIdAfterResult(input, msg, newSessionId);
      if (await reportFailedResult(input, msg, newSessionId)) return;
    }

    if (allChunks.length > MAX_BATCH_TOTAL_CHUNKS) {
      allChunks.shift();
      totalChunksTruncated = true;
    }
  }

  if (newSessionId) {
    await tryPersistSessionId(session.id, newSessionId);
  }

  if (assistantChunksTruncated || totalChunksTruncated) {
    getLog().warn(
      {
        assistantChunksTruncated,
        totalChunksTruncated,
        maxAssistantChunks: MAX_BATCH_ASSISTANT_CHUNKS,
        maxTotalChunks: MAX_BATCH_TOTAL_CHUNKS,
      },
      'batch_mode_chunks_truncated'
    );
  }

  getLog().debug(
    { totalChunks: allChunks.length, assistantMessages: assistantMessages.length },
    'batch_mode_chunks_received'
  );

  // Filter tool indicators and build final message
  const finalMessage = filterToolIndicators(assistantMessages);

  if (toolFailed) return reportUnansweredToolFailure(input);

  if (!finalMessage) {
    // Intentionally NOT counted in chat_turn_handled — an empty response is
    // neither a completed nor a failed turn worth measuring.
    getLog().debug({ conversationId }, 'no_ai_response');
    return;
  }

  getLog().debug({ messageLength: finalMessage.length }, 'sending_final_message');
  await platform.sendMessage(conversationId, finalMessage);
  await completeChatTurn(input, finalMessage);
}

/**
 * Call the adapter's optional `sendResultFooter` hook with the final result
 * metadata from a direct-chat turn. Skips when the adapter doesn't implement
 * it, when there's no metadata to surface, or when the call itself fails —
 * cost footers are informational and must not block the conversation.
 */
async function maybeSendResultFooter(
  platform: IPlatformAdapter,
  conversationId: string,
  info: { cost?: number; tokens?: TokenUsage; stopReason?: string } | undefined
): Promise<void> {
  if (!info) return;
  if (info.cost === undefined && info.tokens === undefined) return;
  if (!platform.sendResultFooter) return;
  try {
    await platform.sendResultFooter(conversationId, info);
  } catch (error) {
    getLog().warn({ err: toError(error), conversationId }, 'orchestrator.result_footer_failed');
  }
}
