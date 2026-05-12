import { createLogger } from '@archon/paths';
import type { MessageMetadata } from '@archon/core';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web.persistence');
  return cachedLog;
}

interface BufferedToolCall {
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
  duration?: number;
  output?: string;
}

interface BufferedSegment {
  content: string;
  toolCalls: BufferedToolCall[];
  category?: MessageMetadata['category'];
  workflowDispatch?: MessageMetadata['workflowDispatch'];
  workflowResult?: MessageMetadata['workflowResult'];
}

interface AssistantBuffer {
  segments: BufferedSegment[];
}

export class MessagePersistence {
  private assistantBuffer = new Map<string, AssistantBuffer>();
  private dbIdMap = new Map<string, string>(); // platform_conversation_id → DB UUID

  constructor(private emitEvent: (conversationId: string, event: string) => Promise<void>) {}

  /**
   * Map a platform conversation ID to its database UUID for message persistence.
   */
  setConversationDbId(platformConversationId: string, dbId: string): void {
    this.dbIdMap.set(platformConversationId, dbId);
  }

  appendText(conversationId: string, message: string, metadata?: MessageMetadata): void {
    if (metadata?.category === 'tool_call_formatted') {
      getLog().debug({ conversationId }, 'persistence_skip_tool_call_formatted');
      return;
    }

    if (metadata?.category === 'isolation_context') {
      getLog().debug({ conversationId }, 'persistence_skip_isolation_context');
      return;
    }

    // Buffer assistant text for persistence (segment-based to preserve message structure)
    const buf = this.assistantBuffer.get(conversationId) ?? { segments: [] };
    const lastSeg = buf.segments[buf.segments.length - 1];
    const isWorkflowStatus =
      metadata?.category === 'workflow_status' || metadata?.category === 'workflow_dispatch_status';

    const segmentDirective = metadata?.segment ?? 'auto';

    // Start a new segment when:
    // 1. No segments yet
    // 2. Previous segment has tool calls (text after tool = new message in live view)
    // 3. This is a workflow status message (🚀/✅ should be its own bubble)
    // 4. Previous segment was a workflow status (next text should be separate)
    const needsNewSegment =
      !lastSeg ||
      segmentDirective === 'new' ||
      (segmentDirective === 'auto' &&
        (lastSeg.toolCalls.length > 0 ||
          isWorkflowStatus ||
          lastSeg.category === 'workflow_status' ||
          lastSeg.category === 'workflow_dispatch_status'));

    if (needsNewSegment) {
      buf.segments.push({
        content: message,
        toolCalls: [],
        category: metadata?.category,
        workflowDispatch: metadata?.workflowDispatch,
        workflowResult: metadata?.workflowResult,
      });
    } else {
      lastSeg.content += message;
    }
    this.assistantBuffer.set(conversationId, buf);

    // Prevent unbounded buffer growth — force flush if too many segments
    if (buf.segments.length > 50) {
      getLog().warn({ conversationId, segments: buf.segments.length }, 'assistant_buffer_overflow');
      this.flush(conversationId).catch((e: unknown) => {
        getLog().error({ conversationId, err: e }, 'buffer_overflow_flush_failed');
      });
    }
  }

  /**
   * Buffer a tool call for persistence (direct chat path).
   * Finalizes duration on the previous running tool when a new one arrives.
   */
  appendToolCall(
    conversationId: string,
    tool: { name: string; input: Record<string, unknown> }
  ): void {
    const buf = this.assistantBuffer.get(conversationId) ?? { segments: [] };
    if (buf.segments.length === 0) {
      buf.segments.push({ content: '', toolCalls: [] });
    }
    const lastSeg = buf.segments[buf.segments.length - 1];
    // Finalize duration on previous running tool
    const now = Date.now();
    const prevTool = lastSeg.toolCalls[lastSeg.toolCalls.length - 1];
    if (prevTool && prevTool.duration === undefined) {
      prevTool.duration = now - prevTool.startedAt;
    }
    lastSeg.toolCalls.push({
      name: tool.name,
      input: tool.input,
      startedAt: now,
    });
    this.assistantBuffer.set(conversationId, buf);
  }

  /**
   * Record tool output for a previously buffered tool call.
   * Matches by name, scanning from the most recent segment to find the last
   * unresolved tool call (no output yet). This mirrors WorkflowLogs.tsx's
   * reverse-iteration approach for multi-tool-same-name correctness.
   */
  appendToolResult(conversationId: string, name: string, output: string, duration: number): void {
    const buf = this.assistantBuffer.get(conversationId);
    if (!buf) {
      getLog().warn({ conversationId, name }, 'tool_result_dropped_no_buffer');
      return;
    }
    let matched = false;
    for (let i = buf.segments.length - 1; i >= 0; i--) {
      const seg = buf.segments[i];
      const tc = [...seg.toolCalls].reverse().find(t => t.name === name && t.output === undefined);
      if (tc) {
        tc.output = output;
        tc.duration = duration;
        matched = true;
        break;
      }
    }
    if (!matched) {
      getLog().warn({ conversationId, name }, 'tool_result_no_matching_tool_call');
    }
  }

  /**
   * Finalize all running tools in the buffer for a conversation.
   * Called on lock release to ensure the last tool gets a duration.
   */
  finalizeRunningTools(conversationId: string): void {
    const buf = this.assistantBuffer.get(conversationId);
    if (!buf) return;
    const now = Date.now();
    for (const seg of buf.segments) {
      const lastTool = seg.toolCalls[seg.toolCalls.length - 1];
      if (lastTool && lastTool.duration === undefined) {
        lastTool.duration = now - lastTool.startedAt;
      }
    }
  }

  /**
   * Flush buffered assistant segments to the database as individual message rows.
   * Each segment maps to one ChatMessage in the frontend, preserving the same
   * structure as the live streaming view (text+tools interleaving).
   */
  async flush(conversationId: string): Promise<void> {
    // Snapshot and clear the buffer synchronously before any async work.
    // This prevents a race where concurrent appendText calls push segments
    // onto the same buf reference that is mid-flush: once the map entry is
    // cleared here, new appendText calls create a fresh buffer entry and
    // those segments won't be dropped when this flush completes.
    const buf = this.assistantBuffer.get(conversationId);
    if (!buf || buf.segments.length === 0) {
      this.assistantBuffer.delete(conversationId);
      return;
    }

    // Pre-set `duration` on the last tool in each segment so terminal tool calls
    // (those that never receive an appendToolResult) don't satisfy the
    // `output === undefined && duration === undefined` in-flight condition below.
    const preNow = Date.now();
    for (const seg of buf.segments) {
      const lastTool = seg.toolCalls[seg.toolCalls.length - 1];
      if (lastTool && lastTool.duration === undefined) {
        lastTool.duration = preNow - lastTool.startedAt;
      }
    }

    // Split: keep segments with in-flight tools (output pending) in the buffer
    // so appendToolResult can still find them. Only flush completed segments.
    const ready: BufferedSegment[] = [];
    const pending: BufferedSegment[] = [];
    for (const seg of buf.segments) {
      const hasInflightTool = seg.toolCalls.some(
        tc => tc.output === undefined && tc.duration === undefined
      );
      if (hasInflightTool) {
        pending.push(seg);
      } else {
        ready.push(seg);
      }
    }

    if (ready.length === 0) {
      // All segments have in-flight tools — nothing to flush yet
      return;
    }

    if (pending.length > 0) {
      // Keep pending segments in the buffer for appendToolResult to find
      buf.segments = pending;
    } else {
      this.assistantBuffer.delete(conversationId);
    }

    const dbId = this.dbIdMap.get(conversationId);
    if (!dbId) {
      getLog().warn({ conversationId, segmentCount: ready.length }, 'assistant_persist_no_db_id');
      // Restore buffer — dbId may arrive later (e.g., race with conversation creation).
      // Merge ready segments back with any that arrived since we split.
      const existing = this.assistantBuffer.get(conversationId);
      if (existing) {
        existing.segments.unshift(...ready);
      } else {
        // pending is always empty here (non-empty pending keeps the buffer alive above)
        this.assistantBuffer.set(conversationId, { segments: [...ready] });
      }
      return;
    }

    // Finalize any remaining tool durations (last tool in each segment)
    const now = Date.now();
    for (const seg of ready) {
      const lastTool = seg.toolCalls[seg.toolCalls.length - 1];
      if (lastTool && lastTool.duration === undefined) {
        lastTool.duration = now - lastTool.startedAt;
      }
    }

    try {
      const { addMessage } = await import('@archon/core/db/messages');
      for (const seg of ready) {
        if (!seg.content && seg.toolCalls.length === 0) continue;
        const toolCalls = seg.toolCalls.map(tc => ({
          name: tc.name,
          input: tc.input,
          duration: tc.duration,
          ...(tc.output !== undefined ? { output: tc.output } : {}),
        }));
        const metadata = {
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(seg.workflowDispatch ? { workflowDispatch: seg.workflowDispatch } : {}),
          ...(seg.workflowResult ? { workflowResult: seg.workflowResult } : {}),
        };
        await addMessage(dbId, 'assistant', seg.content, metadata);
      }
    } catch (e: unknown) {
      getLog().error({ conversationId, err: e }, 'message_persistence_failed');
      void this.emitEvent(
        conversationId,
        JSON.stringify({
          type: 'warning',
          message: 'Assistant response could not be saved to history',
          timestamp: Date.now(),
        })
      );
    }
  }

  /**
   * Remove the last segment from the persistence buffer.
   * Called when emitRetract fires so retracted text doesn't get written to DB.
   */
  retractLastSegment(conversationId: string): void {
    const buf = this.assistantBuffer.get(conversationId);
    if (!buf || buf.segments.length === 0) return;
    const lastSeg = buf.segments[buf.segments.length - 1];
    if (lastSeg.toolCalls.length > 0) {
      // Preserve tool call records — only clear the text content
      lastSeg.content = '';
    } else {
      buf.segments.pop();
      if (buf.segments.length === 0) {
        this.assistantBuffer.delete(conversationId);
      }
    }
  }

  async clearConversation(conversationId: string): Promise<void> {
    // Attempt to flush before clearing so buffered messages aren't lost
    await this.flush(conversationId).catch((e: unknown) => {
      getLog().error({ conversationId, err: e }, 'clear_conversation_flush_failed');
    });
    this.assistantBuffer.delete(conversationId);
    this.dbIdMap.delete(conversationId);
  }

  /**
   * Flush all buffered conversations. Used by shutdown and periodic flush.
   */
  async flushAll(): Promise<void> {
    const ids = [...this.assistantBuffer.keys()];
    if (ids.length === 0) return;
    getLog().info({ count: ids.length }, 'flush_all_started');
    await Promise.allSettled(ids.map(id => this.flush(id)));
    getLog().info({ count: ids.length }, 'flush_all_completed');
  }

  private periodicFlushTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Start a periodic timer that flushes all buffered conversations every 30s.
   * Ensures messages are persisted even if the lock-release flush is missed.
   */
  startPeriodicFlush(): void {
    if (this.periodicFlushTimer) return;
    this.periodicFlushTimer = setInterval(() => {
      this.flushAll().catch((e: unknown) => {
        getLog().error({ err: e }, 'periodic_flush_failed');
      });
    }, 30_000);
  }

  stopPeriodicFlush(): void {
    if (this.periodicFlushTimer) {
      clearInterval(this.periodicFlushTimer);
      this.periodicFlushTimer = undefined;
    }
  }

  clearAll(): void {
    this.assistantBuffer.clear();
    this.dbIdMap.clear();
  }
}
