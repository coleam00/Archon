import { useEffect, useRef, useState, useCallback } from 'react';
import { startsNewTextBatch } from '@/lib/chat-message-reducer';
import type {
  TextEventMeta,
  SSEEvent,
  ErrorDisplay,
  LoopIterationEvent,
  WorkflowStatusEvent,
  WorkflowArtifactEvent,
  WorkflowDispatchEvent,
  WorkflowOutputPreviewEvent,
  WorkflowTaskActivityEvent,
  WorkflowHookActivityEvent,
  DagNodeEvent,
} from '@/lib/types';
import { SSE_BASE_URL } from '@/lib/api';

function parseSSEEvent(raw: string): SSEEvent | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed.type !== 'string') {
      console.error('[SSE] Malformed event: missing type field', { raw });
      return null;
    }
    return parsed as unknown as SSEEvent;
  } catch (parseErr) {
    console.error('[SSE] Failed to parse event:', {
      raw,
      error: (parseErr as Error).message,
    });
    return null;
  }
}

interface SSEHandlers {
  onText: (content: string, meta?: TextEventMeta) => void;
  onToolCall: (name: string, input: Record<string, unknown>, toolCallId?: string) => void;
  onToolResult: (name: string, output: string, duration: number, toolCallId?: string) => void;
  onError: (error: ErrorDisplay) => void;
  onLockChange: (locked: boolean, queuePosition?: number) => void;
  onSessionInfo: (sessionId: string, cost?: number) => void;
  onWorkflowStatus?: (event: WorkflowStatusEvent) => void;
  onWorkflowArtifact?: (event: WorkflowArtifactEvent) => void;
  onDagNode?: (event: DagNodeEvent) => void;
  onLoopIteration?: (event: LoopIterationEvent) => void;
  onWorkflowDispatch?: (event: WorkflowDispatchEvent) => void;
  onWorkflowOutputPreview?: (event: WorkflowOutputPreviewEvent) => void;
  onTaskActivity?: (event: WorkflowTaskActivityEvent) => void;
  onHookActivity?: (event: WorkflowHookActivityEvent) => void;
  onWarning?: (message: string) => void;
  onRetract?: () => void;
  onSystemStatus?: (content: string) => void;
}

export function useSSE(
  conversationId: string | null,
  handlers: SSEHandlers
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Text batching: accumulate text for 50ms before dispatching. The batch is
  // dispatched as ONE message, so `pendingMetaRef` holds the single identity
  // (category + finished run) that the buffered text belongs to.
  const textBufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMetaRef = useRef<TextEventMeta>({});

  const flushText = useCallback((): void => {
    if (textBufferRef.current) {
      handlersRef.current.onText(textBufferRef.current, pendingMetaRef.current);
      textBufferRef.current = '';
      pendingMetaRef.current = {};
    }
    flushTimerRef.current = null;
  }, []);

  /** Cancel the batching window and dispatch immediately, if anything is buffered. */
  const flushTextNow = useCallback((): void => {
    if (!textBufferRef.current) return;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    flushText();
  }, [flushText]);

  useEffect(() => {
    if (!conversationId) return;

    const eventSource = new EventSource(
      `${SSE_BASE_URL}/api/stream/${encodeURIComponent(conversationId)}`
    );

    eventSource.onopen = (): void => {
      setConnected(true);
    };

    eventSource.onerror = (): void => {
      // Only mark disconnected when the connection is permanently closed,
      // not during transient CONNECTING reconnection attempts (prevents flicker)
      if (eventSource.readyState === EventSource.CLOSED) {
        setConnected(false);
        handlersRef.current.onError({
          message: 'Lost connection to server. Please refresh the page.',
          classification: 'transient',
          suggestedActions: ['Refresh the page', 'Check that the server is running'],
        });
      } else if (eventSource.readyState === EventSource.CONNECTING) {
        console.warn('[SSE] Connection error, reconnecting...', { conversationId });
      }
    };

    eventSource.onmessage = (event: MessageEvent): void => {
      const data = parseSSEEvent(event.data as string);
      if (!data) {
        handlersRef.current.onError({
          message: 'Received malformed response from server',
          classification: 'transient',
          suggestedActions: ['Refresh the page if chat appears stuck'],
        });
        return;
      }

      try {
        const h = handlersRef.current;

        switch (data.type) {
          case 'text': {
            // A batch speaks for one message, so it can carry only one identity:
            // one category and one finished run. When either changes, flush first.
            //
            // Category: without this a workflow-status line batched behind agent
            // prose would inherit — or overwrite — the wrong category and lose its
            // own bubble. Run: two `workflow_result` events for different runs can
            // arrive back-to-back (SSETransport replays its buffer on reconnect),
            // and merging them would drop one result card and splice the summaries.
            const incoming: TextEventMeta = {
              category: data.category,
              workflowResult: data.workflowResult ?? undefined,
            };
            if (startsNewTextBatch(pendingMetaRef.current, incoming)) {
              flushTextNow();
            }
            textBufferRef.current += data.content;
            pendingMetaRef.current = incoming;
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(flushText, 50);
            }
            break;
          }
          case 'tool_call':
            // Flush buffered text before tool events to ensure text
            // attaches to the correct message (not the previous one)
            flushTextNow();
            h.onToolCall(data.name, data.input, data.toolCallId);
            break;
          case 'tool_result':
            // Flush buffered text before tool result too
            flushTextNow();
            h.onToolResult(data.name, data.output, data.duration, data.toolCallId);
            break;
          case 'error':
            h.onError({
              message: data.message,
              classification: data.classification ?? 'transient',
              suggestedActions: data.suggestedActions ?? [],
            });
            break;
          case 'conversation_lock':
            // Flush any buffered text before processing lock change,
            // otherwise text arriving just before lock release creates
            // a streaming message that never gets cleared.
            if (!data.locked) {
              flushTextNow();
            }
            h.onLockChange(data.locked, data.queuePosition);
            break;
          case 'session_info':
            h.onSessionInfo(data.sessionId, data.cost);
            break;
          case 'workflow_status':
            h.onWorkflowStatus?.(data);
            if (
              data.status === 'completed' ||
              data.status === 'failed' ||
              data.status === 'cancelled'
            ) {
              h.onLockChange(false);
            }
            break;
          case 'workflow_artifact':
            h.onWorkflowArtifact?.(data);
            break;
          case 'dag_node':
            h.onDagNode?.(data);
            break;
          case 'workflow_step':
            h.onLoopIteration?.(data);
            break;
          case 'workflow_dispatch':
            // Flush buffered text before dispatch events to ensure the
            // `workflow_dispatch_status` message is committed as an assistant message
            // before onWorkflowDispatch attaches metadata to the "last assistant message".
            flushTextNow();
            h.onWorkflowDispatch?.(data);
            break;
          case 'workflow_output_preview':
            h.onWorkflowOutputPreview?.(data);
            break;
          case 'workflow_task_activity':
            h.onTaskActivity?.(data);
            break;
          case 'workflow_hook_activity':
            h.onHookActivity?.(data);
            break;
          case 'warning':
            h.onWarning?.(data.message);
            break;
          case 'system_status':
            h.onSystemStatus?.(data.content);
            break;
          case 'retract':
            // Discard any buffered text (don't flush to UI)
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            textBufferRef.current = '';
            pendingMetaRef.current = {};
            h.onRetract?.();
            break;
          case 'heartbeat':
            break;
          default: {
            console.warn('[SSE] Unknown event type', { type: (data as { type: string }).type });
            break;
          }
        }
      } catch (handlerError) {
        console.error('[SSE] Handler error for event type:', data.type, handlerError);
        try {
          handlersRef.current.onError({
            message: `Failed to process ${data.type} event. UI may be out of sync.`,
            classification: 'transient',
            suggestedActions: ['Refresh the page if chat appears stuck'],
          });
        } catch {
          // Avoid infinite loop if onError itself throws
        }
      }
    };

    return (): void => {
      eventSource.close();
      setConnected(false);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushText();
      }
    };
  }, [conversationId, flushText, flushTextNow]);

  return { connected };
}
