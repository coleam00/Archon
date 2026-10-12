import { apiPolicy } from './headless-policy';
import {
  spellWorkflowCommand,
  type IWorkflowPlatform,
  type WorkflowMessageMetadata,
  type WorkflowCommandSurface,
} from '@archon/workflows/deps';

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
    // A recorder failure propagates: the workflow's send boundary logs it with run context.
    await this.recorder?.(message, metadata);
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return apiPolicy.id;
  }
}
