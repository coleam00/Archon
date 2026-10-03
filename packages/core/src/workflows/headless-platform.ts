import {
  spellWorkflowCommand,
  type IWorkflowPlatform,
  type WorkflowMessageMetadata,
  type WorkflowCommandSurface,
} from '@archon/workflows/deps';
import { createLogger } from '@archon/paths';
import { toPersistedMessageMetadata } from '../types';
import * as messageDb from '../db/messages';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.headless');
  return cachedLog;
}

/**
 * Minimal `IWorkflowPlatform` bound to a single run's own conversation DB id.
 * One instance per resume attempt — there is exactly one conversation to
 * persist into, so the id is fixed at construction rather than looked up
 * per call.
 */
export class HeadlessPlatform implements IWorkflowPlatform {
  constructor(
    private readonly conversationDbId: string,
    private readonly surface: WorkflowCommandSurface = {}
  ) {}

  formatWorkflowCommand(command: string): string {
    return spellWorkflowCommand(this.surface, command);
  }

  async sendMessage(
    _conversationId: string,
    message: string,
    metadata?: WorkflowMessageMetadata
  ): Promise<void> {
    try {
      await messageDb.addMessage(
        this.conversationDbId,
        'assistant',
        message,
        toPersistedMessageMetadata(metadata)
      );
    } catch (error) {
      getLog().warn(
        { err: error as Error, conversationDbId: this.conversationDbId },
        'headless_message_persist_failed'
      );
    }
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'api';
  }
}
