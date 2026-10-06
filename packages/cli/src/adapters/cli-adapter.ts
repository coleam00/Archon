/**
 * CLI adapter for stdout output
 * Implements IPlatformAdapter to allow workflow execution via command line
 */
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.adapter');
  return cachedLog;
}

/** Configuration options for CLIAdapter */
export interface CLIAdapterOptions {
  recordMessage?: (
    conversationId: string,
    message: string,
    metadata?: MessageMetadata
  ) => Promise<void>;
  /** Streaming mode - 'stream' for real-time output, 'batch' for accumulated output */
  streamingMode?: 'stream' | 'batch';
}

export class CLIAdapter implements IPlatformAdapter {
  readonly capabilities = {
    messagePersistence: 'core',
    defaultWorkflowDispatch: 'foreground',
  } as const;
  private readonly streamingMode: 'stream' | 'batch';
  private readonly recordMessage: CLIAdapterOptions['recordMessage'];

  constructor(options?: CLIAdapterOptions) {
    this.streamingMode = options?.streamingMode ?? 'batch';
    this.recordMessage = options?.recordMessage;
  }

  async sendMessage(
    conversationId: string,
    message: string,
    metadata?: MessageMetadata
  ): Promise<void> {
    // Output to stdout
    console.log(message);

    if (this.recordMessage) {
      try {
        await this.recordMessage(conversationId, message, metadata);
      } catch (error) {
        getLog().warn({ err: error as Error }, 'cli_message_persist_failed');
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

  formatWorkflowCommand(command: string): string {
    return CLI_WORKFLOW_SURFACE.formatWorkflowCommand(command);
  }

  async start(): Promise<void> {
    // No-op for CLI
  }

  stop(): void {
    // No-op for CLI
  }
}
