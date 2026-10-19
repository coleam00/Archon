import { createLogger } from '@archon/paths';
import type { IWorkflowPlatform, WorkflowMessageMetadata } from './deps';

/** Lazy-initialized logger, under the executor-shared name these events have always carried. */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor-shared');
  return cachedLog;
}

/** Context for platform message sending */
export interface SendMessageContext {
  workflowId?: string;
  nodeName?: string;
}

/**
 * Send a message to the platform without failing the run when the send fails.
 * Returns true if the message was sent, false otherwise. A send failure is logged and
 * suppressed whatever it says: no adapter reports a typed send failure, and the run's
 * results persist whether or not the platform heard about them.
 */
export async function safeSendMessage(
  platform: IWorkflowPlatform,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  metadata?: WorkflowMessageMetadata
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message, metadata);
    return true;
  } catch (error) {
    const err = error as Error;
    getLog().error(
      {
        err,
        conversationId,
        messageLength: message.length,
        platformType: platform.getPlatformType(),
        ...context,
        stack: err.stack,
      },
      'platform_message_send_failed'
    );
    return false;
  }
}

/**
 * Delay execution for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a critical message with retry logic.
 * Used for failure/completion notifications that the user must receive.
 */
export async function sendCriticalMessage(
  platform: IWorkflowPlatform,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  maxRetries = 3,
  metadata?: WorkflowMessageMetadata
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await platform.sendMessage(conversationId, message, metadata);
      return true;
    } catch (error) {
      const err = error as Error;
      getLog().error(
        {
          err,
          conversationId,
          messageLength: message.length,
          platformType: platform.getPlatformType(),
          ...context,
          attempt,
          maxRetries,
        },
        'platform.critical_message_send_failed'
      );

      // Wait before retry (linear backoff: 1s × attempt)
      if (attempt < maxRetries) {
        await delay(1000 * attempt);
      }
    }
  }

  // Log prominently so operators can manually notify user
  getLog().error(
    { conversationId, messageLength: message.length, ...context },
    'critical_message_delivery_failed'
  );

  return false;
}
