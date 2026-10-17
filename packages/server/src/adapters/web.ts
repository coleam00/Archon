/**
 * Web platform adapter implementing IPlatformAdapter with SSE stream management.
 * Bridge between the orchestrator and the React frontend via Server-Sent Events.
 */
import { webPolicy } from '@archon/adapters/web/policy';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import type { PlatformStructuredEvent } from '@archon/workflows/deps';
import { toolCallDisplayName } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import { MessagePersistence } from './web/persistence';
import { SSETransport, type SSEWriter } from './web/transport';
import { WorkflowEventBridge } from './web/workflow-bridge';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web');
  return cachedLog;
}

export class WebAdapter implements IPlatformAdapter {
  readonly capabilities = {
    canDetachProject: true as const,
    messagePersistence: 'adapter',
    defaultWorkflowDispatch: 'background',
  } as const;
  /**
   * Per-conversation running tool stack for SSE duration tracking.
   * Uses a Map of toolCallId → start info so parallel DAG nodes don't
   * overwrite each other (they share a conversationId).
   */
  private runningTools = new Map<
    string,
    Map<string, { toolCallId: string; name: string; startedAt: number }>
  >();

  constructor(
    private transport: SSETransport,
    private persistence: MessagePersistence,
    private workflowBridge: WorkflowEventBridge
  ) {}

  /**
   * Dashboard connections coexist; a conversation reconnect replaces its old stream.
   */
  registerStream(conversationId: string, stream: SSEWriter): void {
    this.transport.registerStream(conversationId, stream);
  }

  removeStream(conversationId: string, expectedStream?: SSEWriter): void {
    // Clean up stale tool tracking state once the last writer is gone to prevent
    // spurious tool_result events on the next message to this conversation. A
    // stale writer leaving while another is live must not wipe live tool state.
    if (this.transport.removeStream(conversationId, expectedStream)) {
      this.runningTools.delete(conversationId);
    }
  }

  /**
   * Map a platform conversation ID to its database UUID for message persistence.
   */
  setConversationDbId(platformConversationId: string, dbId: string): void {
    this.persistence.setConversationDbId(platformConversationId, dbId);
  }

  async sendMessage(
    conversationId: string,
    message: string,
    metadata?: MessageMetadata
  ): Promise<void> {
    this.persistence.appendText(conversationId, message, metadata);

    // Categories that are handled structurally in the web UI (not as chat messages)
    if (
      metadata?.category === 'tool_call_formatted' ||
      metadata?.category === 'isolation_context'
    ) {
      return;
    }

    // `category` rides the wire so the client segments messages from the same
    // typed signal `MessagePersistence.appendText` uses (persistence.ts), rather
    // than re-deriving it by pattern-matching the message text.
    const event = JSON.stringify({
      type: 'text',
      content: message,
      isComplete: true,
      timestamp: Date.now(),
      ...(metadata?.category ? { category: metadata.category } : {}),
      ...(metadata?.workflowResult ? { workflowResult: metadata.workflowResult } : {}),
    });

    await this.transport.emit(conversationId, event);

    // Workflow result arrives after the parent lock is released (background dispatch),
    // so it would never be flushed. Force persistence flush for these messages.
    if (metadata?.category === 'workflow_result') {
      this.persistence.flush(conversationId).catch((e: unknown) => {
        getLog().error({ conversationId, err: e }, 'workflow_result_flush_failed');
      });
    }
  }

  async sendStructuredEvent(conversationId: string, chunk: PlatformStructuredEvent): Promise<void> {
    let event: string;

    if (chunk.type === 'tool_call') {
      const now = Date.now();
      const name = toolCallDisplayName(chunk);
      const input = chunk.rawInput === undefined ? {} : chunk.rawInput;

      // Buffer tool call for direct chat persistence (message metadata)
      this.persistence.appendToolCall(conversationId, {
        toolCallId: chunk.toolCallId,
        name,
        input,
      });

      // Track this tool's start for duration computation (supports parallel DAG nodes)
      let convTools = this.runningTools.get(conversationId);
      if (!convTools) {
        convTools = new Map();
        this.runningTools.set(conversationId, convTools);
      }
      convTools.set(chunk.toolCallId, { toolCallId: chunk.toolCallId, name, startedAt: now });

      event = JSON.stringify({
        type: 'tool_call',
        toolCallId: chunk.toolCallId,
        name,
        input,
        timestamp: now,
      });
    } else if (chunk.type === 'tool_call_update') {
      const now = Date.now();
      const convTools = this.runningTools.get(conversationId);
      const tool = convTools?.get(chunk.toolCallId);
      if (!tool) {
        // The SSE event still goes out, but the UI cannot pair it to a running card.
        getLog().warn(
          { conversationId, toolCallId: chunk.toolCallId },
          'web_adapter.tool_result_unmatched'
        );
      }
      convTools?.delete(chunk.toolCallId);
      const duration = now - (tool?.startedAt ?? now);
      // The provider already capped the output (TOOL_OUTPUT_MAX_CHARS).
      const output = chunk.output ?? '';
      try {
        this.persistence.appendToolResult(conversationId, chunk.toolCallId, output, duration, {
          status: chunk.status,
          exitCode: chunk.exitCode,
        });
      } catch (e: unknown) {
        getLog().error({ conversationId, err: e }, 'tool_result_persist_failed');
      }
      event = JSON.stringify({
        type: 'tool_result',
        toolCallId: chunk.toolCallId,
        name: tool?.name,
        output,
        status: chunk.status,
        ...(chunk.exitCode !== undefined ? { exitCode: chunk.exitCode } : {}),
        duration,
        timestamp: now,
      });
    } else if (chunk.type === 'result') {
      return;
    } else if (chunk.type === 'workflow_dispatch') {
      event = JSON.stringify({
        type: 'workflow_dispatch',
        workerConversationId: chunk.workerConversationId,
        workflowName: chunk.workflowName,
        timestamp: Date.now(),
      });
    } else if (chunk.type === 'system_status') {
      event = JSON.stringify({
        type: 'system_status',
        content: chunk.content,
        timestamp: Date.now(),
      });
    } else {
      const unhandled: never = chunk;
      throw new Error(`Unhandled structured event: ${JSON.stringify(unhandled)}`);
    }

    await this.transport.emit(conversationId, event);
  }

  async ensureThread(originalConversationId: string): Promise<string> {
    return originalConversationId;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'stream';
  }

  getPlatformType(): string {
    return webPolicy.id;
  }

  async start(): Promise<void> {
    this.workflowBridge.setStepTransitionCallback((workerConversationId: string) => {
      this.persistence.flush(workerConversationId).catch((e: unknown) => {
        getLog().error(
          { conversationId: workerConversationId, err: e },
          'step_transition_flush_failed'
        );
      });
    });
    this.workflowBridge.start();
    this.transport.start();
    this.persistence.startPeriodicFlush();
  }

  async stop(): Promise<void> {
    this.persistence.stopPeriodicFlush();
    await this.persistence.flushAll();
    this.transport.stop();
    this.workflowBridge.stop();
    this.persistence.clearAll();
    this.runningTools.clear();
  }

  /**
   * Emit a lock event to the SSE stream for a conversation.
   * Called by API routes based on acquireLock() return status.
   */
  async emitLockEvent(
    conversationId: string,
    locked: boolean,
    queuePosition?: number
  ): Promise<void> {
    if (!locked) {
      // Finalize ALL running tools and emit tool_result for each before lock release
      const convTools = this.runningTools.get(conversationId);
      if (convTools && convTools.size > 0) {
        const now = Date.now();
        for (const tool of convTools.values()) {
          const duration = now - tool.startedAt;
          const resultEvent = JSON.stringify({
            type: 'tool_result',
            toolCallId: tool.toolCallId,
            name: tool.name,
            output: '',
            duration,
            timestamp: now,
          });
          await this.transport.emit(conversationId, resultEvent);
          // Persist fallback output to DB (real output may have been captured via PostToolUse hook)
          try {
            this.persistence.appendToolResult(conversationId, tool.toolCallId, '', duration);
          } catch (e: unknown) {
            getLog().error({ conversationId, err: e }, 'tool_result_persist_failed');
          }
        }
        this.runningTools.delete(conversationId);
      }
      // Finalize tool durations in persistence buffer before flushing to DB
      this.persistence.finalizeRunningTools(conversationId);
      await this.persistence.flush(conversationId).catch((e: unknown) => {
        getLog().error({ conversationId, err: e }, 'lock_release_flush_failed');
      });
    }
    // Use transport.emit() directly so the lock event is fully awaited and ordered after tool_results
    const lockEvent = JSON.stringify({
      type: 'conversation_lock',
      conversationId,
      locked,
      queuePosition,
      timestamp: Date.now(),
    });
    await this.transport.emit(conversationId, lockEvent);
  }

  hasActiveStream(conversationId: string): boolean {
    return this.transport.hasActiveStream(conversationId);
  }

  async prepareBackgroundConversation(
    context: Parameters<NonNullable<IPlatformAdapter['prepareBackgroundConversation']>>[0]
  ): Promise<() => Promise<void>> {
    const { workerConversationId, parentConversationId, conversationDbId } = context;
    this.setConversationDbId(workerConversationId, conversationDbId);
    // Worker workflow events are forwarded to the parent conversation's stream.
    const unsubscribe = this.workflowBridge.bridgeWorkerEvents(
      workerConversationId,
      parentConversationId
    );
    return async () => {
      unsubscribe();
      await this.emitLockEvent(workerConversationId, false);
    };
  }

  async emitRetract(conversationId: string): Promise<void> {
    // Remove retracted text from persistence buffer so it doesn't get written to DB
    this.persistence.retractLastSegment(conversationId);
    const event = JSON.stringify({
      type: 'retract',
      timestamp: Date.now(),
    });
    await this.transport.emit(conversationId, event);
  }

  async emitSSE(conversationId: string, event: string): Promise<void> {
    await this.transport.emit(conversationId, event);
  }
}
