/**
 * Web platform adapter implementing IPlatformAdapter with SSE stream management.
 * Bridge between the orchestrator and the React frontend via Server-Sent Events.
 */
import type { IWebPlatformAdapter, MessageMetadata } from '@archon/core';
import type { MessageChunk } from '@archon/providers/types';
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

export class WebAdapter implements IWebPlatformAdapter {
  /** Per-conversation tool call counter for unique SSE tool IDs */
  private toolCallCounter = new Map<string, number>();
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
   * Register an SSE stream for a conversation.
   * Closes any existing stream (browser refresh / new tab replaces old).
   */
  registerStream(conversationId: string, stream: SSEWriter): void {
    this.transport.registerStream(conversationId, stream);
  }

  removeStream(conversationId: string, expectedStream?: SSEWriter): void {
    this.transport.removeStream(conversationId, expectedStream);
    // Clean up stale tool tracking state on SSE disconnect to prevent
    // spurious tool_result events on the next message to this conversation.
    this.runningTools.delete(conversationId);
    this.toolCallCounter.delete(conversationId);
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

    const event = JSON.stringify({
      type: 'text',
      content: message,
      isComplete: true,
      timestamp: Date.now(),
      ...(metadata?.workflowResult ? { workflowResult: metadata.workflowResult } : {}),
    });

    // Forward output to registered callback (for event bridge preview)
    this.workflowBridge.emitOutput(conversationId, message);

    await this.transport.emit(conversationId, event);

    // Workflow result arrives after the parent lock is released (background dispatch),
    // so it would never be flushed. Force persistence flush for these messages.
    if (metadata?.category === 'workflow_result') {
      this.persistence.flush(conversationId).catch((e: unknown) => {
        getLog().error({ conversationId, err: e }, 'workflow_result_flush_failed');
      });
    }
  }

  async sendStructuredEvent(conversationId: string, chunk: MessageChunk): Promise<void> {
    let event: string;

    if (chunk.type === 'tool' && chunk.toolName) {
      const now = Date.now();

      // Buffer tool call for direct chat persistence (message metadata)
      this.persistence.appendToolCall(conversationId, {
        name: chunk.toolName,
        input: chunk.toolInput ?? {},
      });

      // Prefer the SDK-provided stable ID (e.g. Claude `tool_use_id`); fall back to a
      // generated counter for clients that don't supply one (e.g. Codex). Stable IDs
      // guarantee tool_call/tool_result pair correctly under concurrent same-named tools.
      let toolCallId: string;
      if (chunk.toolCallId) {
        toolCallId = chunk.toolCallId;
      } else {
        const counter = (this.toolCallCounter.get(conversationId) ?? 0) + 1;
        this.toolCallCounter.set(conversationId, counter);
        toolCallId = `${conversationId}-tool-${String(counter)}`;
      }

      // Track this tool's start for duration computation (supports parallel DAG nodes)
      let convTools = this.runningTools.get(conversationId);
      if (!convTools) {
        convTools = new Map();
        this.runningTools.set(conversationId, convTools);
      }
      convTools.set(toolCallId, { toolCallId, name: chunk.toolName, startedAt: now });

      event = JSON.stringify({
        type: 'tool_call',
        toolCallId,
        name: chunk.toolName,
        input: chunk.toolInput ?? {},
        timestamp: now,
      });
    } else if (chunk.type === 'tool_result' && chunk.toolName) {
      const now = Date.now();
      // Find and remove the matching running tool entry. Prefer stable ID lookup
      // (correct under concurrent same-named tools), fall back to name reverse-scan
      // for clients that don't supply an ID.
      const convTools = this.runningTools.get(conversationId);
      let matchedToolCallId: string | undefined;
      let startedAt = now;
      if (convTools) {
        if (chunk.toolCallId && convTools.has(chunk.toolCallId)) {
          const t = convTools.get(chunk.toolCallId);
          if (t) {
            matchedToolCallId = chunk.toolCallId;
            startedAt = t.startedAt;
            convTools.delete(chunk.toolCallId);
          }
        } else {
          // Reverse iterate to match the most recent tool with this name
          for (const [id, t] of [...convTools.entries()].reverse()) {
            if (t.name === chunk.toolName) {
              matchedToolCallId = id;
              startedAt = t.startedAt;
              convTools.delete(id);
              break;
            }
          }
        }
      }
      if (!matchedToolCallId) {
        // Neither stable-ID lookup nor name reverse-scan found a match. The
        // SSE event still goes out, but the UI cannot pair it to a running
        // card and the entry (if any) will leak in runningTools. Surface this
        // so we can debug missing tool_call emissions.
        getLog().warn(
          {
            conversationId,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
          },
          'web_adapter.tool_result_unmatched'
        );
      }
      const duration = now - startedAt;
      // Persist tool output to DB
      try {
        this.persistence.appendToolResult(
          conversationId,
          chunk.toolName,
          chunk.toolOutput,
          duration
        );
      } catch (e: unknown) {
        getLog().error({ conversationId, err: e }, 'tool_result_persist_failed');
      }
      event = JSON.stringify({
        type: 'tool_result',
        toolCallId: matchedToolCallId,
        name: chunk.toolName,
        output: chunk.toolOutput,
        duration,
        timestamp: now,
      });
    } else if (chunk.type === 'result' && chunk.sessionId) {
      event = JSON.stringify({
        type: 'session_info',
        sessionId: chunk.sessionId,
        timestamp: Date.now(),
      });
    } else if (chunk.type === 'workflow_dispatch') {
      event = JSON.stringify({
        type: 'workflow_dispatch',
        workerConversationId: chunk.workerConversationId,
        workflowName: chunk.workflowName,
        timestamp: Date.now(),
      });
    } else if (chunk.type === 'system') {
      event = JSON.stringify({
        type: 'system_status',
        content: chunk.content,
        timestamp: Date.now(),
      });
    } else {
      return;
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
    return 'web';
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
    this.toolCallCounter.clear();
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
            this.persistence.appendToolResult(conversationId, tool.name, '', duration);
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

  /**
   * Bridge workflow events from a worker conversation to a parent conversation's SSE stream.
   * Forwards compact progress events (step progress, status) and output previews.
   */
  setupEventBridge(workerConversationId: string, parentConversationId: string): () => void {
    return this.workflowBridge.bridgeWorkerEvents(workerConversationId, parentConversationId);
  }

  registerOutputCallback(conversationId: string, callback: (text: string) => void): void {
    this.workflowBridge.registerOutputCallback(conversationId, callback);
  }

  removeOutputCallback(conversationId: string): void {
    this.workflowBridge.removeOutputCallback(conversationId);
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
