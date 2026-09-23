/**
 * Headless workflow platform for server-side direct resume execution.
 *
 * `executeWorkflow` only requires `IWorkflowPlatform` (a narrow subset of
 * `IPlatformAdapter`), not a full chat adapter. Used by `resumeRunHeadless`
 * (routes/api.ts, #2008) to resume a run with no parent conversation to
 * dispatch a chat message through — there is no live transport, so this only
 * persists the run's messages for history; it never streams anywhere.
 */
import type { IWorkflowPlatform, WorkflowMessageMetadata } from '@archon/workflows/deps';
import { createLogger } from '@archon/paths';
import { toPersistedMessageMetadata } from '@archon/core/types';
import * as messageDb from '@archon/core/db/messages';

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
  constructor(private readonly conversationDbId: string) {}

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
