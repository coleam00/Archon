/**
 * CLI adapter for stdout output
 * Implements IPlatformAdapter to allow workflow execution via command line
 */
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import * as messageDb from '@archon/core/db/messages';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.adapter');
  return cachedLog;
}

/** Configuration options for CLIAdapter */
export interface CLIAdapterOptions {
  /** Streaming mode - 'stream' for real-time output, 'batch' for accumulated output */
  streamingMode?: 'stream' | 'batch';
}

export class CLIAdapter implements IPlatformAdapter {
  private readonly streamingMode: 'stream' | 'batch';
  private readonly dbIdMap = new Map<string, string>(); // platform_conversation_id → DB UUID

  constructor(options?: CLIAdapterOptions) {
    this.streamingMode = options?.streamingMode ?? 'batch';
  }

  /**
   * Map a platform conversation ID to its database UUID for message persistence.
   * Must be called after conversation creation and before executeWorkflow.
   */
  setConversationDbId(conversationId: string, dbId: string): void {
    this.dbIdMap.set(conversationId, dbId);
  }

  async sendMessage(
    conversationId: string,
    message: string,
    metadata?: MessageMetadata
  ): Promise<void> {
    // Output to stdout
    console.log(message);

    // Persist assistant message for Web UI history
    const dbId = this.dbIdMap.get(conversationId);
    if (dbId) {
      try {
        // Build persistence metadata from MessageMetadata (mirror web adapter pattern)
        const persistMeta: Record<string, unknown> = {};
        if (metadata?.category) persistMeta.category = metadata.category;
        if (metadata?.workflowDispatch) persistMeta.workflowDispatch = metadata.workflowDispatch;
        if (metadata?.workflowResult) persistMeta.workflowResult = metadata.workflowResult;

        await messageDb.addMessage(
          dbId,
          'assistant',
          message,
          Object.keys(persistMeta).length > 0 ? persistMeta : undefined
        );
      } catch (error) {
        getLog().warn(
          { err: error as Error, conversationDbId: dbId },
          'cli_message_persist_failed'
        );
      }
    }
  }

  /**
   * CLI has no threading - passthrough
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  getPlatformType(): string {
    return 'cli';
  }

  async start(): Promise<void> {
    // No-op for CLI
  }

  stop(): void {
    // No-op for CLI
  }
}
