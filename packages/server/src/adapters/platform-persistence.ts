/**
 * Persistence wrapper for non-web platform adapters (Discord, Slack, Telegram).
 *
 * The Web UI reads conversation history from remote_agent_messages. Incoming
 * user messages from chat platforms and outgoing assistant replies were never
 * written there — so Web UI threads appeared empty even though the Discord
 * thread had the full exchange. This wrapper persists both sides.
 */
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { messageDb } from '@archon/core';
import type { MessageChunk } from '@archon/providers/types';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.platform-persistence');
  return cachedLog;
}

/**
 * Wrap a platform adapter so every sendMessage also persists as an 'assistant'
 * row in remote_agent_messages. Persistence failures are logged but never
 * propagate — sending to the platform is always the source of truth.
 *
 * dbId is the conversation UUID from remote_agent_conversations.id (not the
 * platform conversation id / thread id).
 */
export function wrapAdapterWithPersistence(
  adapter: IPlatformAdapter,
  dbId: string
): IPlatformAdapter {
  const wrapped: IPlatformAdapter = {
    async sendMessage(
      conversationId: string,
      message: string,
      metadata?: MessageMetadata
    ): Promise<void> {
      await adapter.sendMessage(conversationId, message, metadata);
      if (!message) return;
      try {
        const md: Record<string, unknown> | undefined = metadata ? { ...metadata } : undefined;
        await messageDb.addMessage(dbId, 'assistant', message, md);
      } catch (err) {
        getLog().error(
          { err, dbId, platform: adapter.getPlatformType() },
          'platform_message_persist_failed'
        );
      }
    },
    ensureThread: (originalConversationId, messageContext) =>
      adapter.ensureThread(originalConversationId, messageContext),
    getStreamingMode: () => adapter.getStreamingMode(),
    getPlatformType: () => adapter.getPlatformType(),
    start: () => adapter.start(),
    stop: (): void => {
      adapter.stop();
    },
  };

  // Forward optional methods only when the underlying adapter implements them,
  // so feature-detection (e.g. `if (platform.sendStructuredEvent)`) in the
  // orchestrator still works correctly.
  if (adapter.sendStructuredEvent) {
    const send = adapter.sendStructuredEvent.bind(adapter);
    wrapped.sendStructuredEvent = async (
      conversationId: string,
      event: MessageChunk
    ): Promise<void> => {
      await send(conversationId, event);
    };
  }
  if (adapter.emitRetract) {
    const retract = adapter.emitRetract.bind(adapter);
    wrapped.emitRetract = async (conversationId: string): Promise<void> => {
      await retract(conversationId);
    };
  }

  return wrapped;
}

/**
 * Persist an incoming user message. Logged but not thrown on failure — we want
 * the orchestrator to still respond even if history persistence fails.
 */
export async function persistUserMessage(
  dbId: string,
  platformType: string,
  content: string
): Promise<void> {
  try {
    await messageDb.addMessage(dbId, 'user', content);
  } catch (err) {
    getLog().error({ err, dbId, platformType }, 'platform_user_message_persist_failed');
  }
}
