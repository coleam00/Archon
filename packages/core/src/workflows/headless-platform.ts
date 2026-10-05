import {
  spellWorkflowCommand,
  type IWorkflowPlatform,
  type WorkflowMessageMetadata,
  type WorkflowCommandSurface,
} from '@archon/workflows/deps';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.headless');
  return cachedLog;
}

export type WorkflowMessageRecorder = (
  message: string,
  metadata?: WorkflowMessageMetadata
) => Promise<void>;

export class HeadlessPlatform implements IWorkflowPlatform {
  constructor(
    private readonly recorder?: WorkflowMessageRecorder,
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
      await this.recorder?.(message, metadata);
    } catch (error) {
      getLog().warn({ err: error as Error }, 'headless_message_persist_failed');
    }
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'api';
  }
}
