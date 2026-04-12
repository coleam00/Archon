import { useEffect, useRef, useState, useCallback } from 'react';
import type {
  SSEEvent,
  ErrorDisplay,
  LoopIterationEvent,
  WorkflowStatusEvent,
  WorkflowArtifactEvent,
  WorkflowDispatchEvent,
  WorkflowOutputPreviewEvent,
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
  onText: (content: string, workflowResult?: { workflowName: string; runId: string }) => void;
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

  // Text batching: accumulate text for 50ms before dispatching
  const textBufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkflowResultRef = useRef<{ workflowName: string; runId: string } | undefined>(
    undefined
  );

  const flushText = useCallback((): void => {
    if (textBufferRef.current) {
      handlersRef.current.onText(textBufferRef.current, pendingWorkflowResultRef.current);
      textBufferRef.current = '';
      pendingWorkflowResultRef.current = undefined;
    }
    flushTimerRef.current = null;
  }, []);

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
          case 'text':
            textBufferRef.current += data.content;
            if (
              'workflowResult' in data &&
              data.workflowResult &&
              typeof data.workflowResult === 'object'
            ) {
              pendingWorkflowResultRef.current = data.workflowResult as {
                workflowName: string;
                runId: string;
              };
            }
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(flushText, 50);
            }
            break;
          case 'tool_call':
            // Flush buffered text before tool events to ensure text
            // attaches to the correct message (not the previous one)
            if (textBufferRef.current) {
              if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
              }
              flushText();
            }
            h.onToolCall(data.name, data.input, data.toolCallId);
            break;
          case 'tool_result':
            // Flush buffered text before tool result too
            if (textBufferRef.current) {
              if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
              }
              flushText();
            }
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
            if (!data.locked && textBufferRef.current) {
              if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
              }
              flushText();
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
            // Flush buffered text before dispatch events to ensure the dispatch
            // message (🚀) is committed as an assistant message before
            // onWorkflowDispatch attaches metadata to the "last assistant message".
            if (textBufferRef.current) {
              if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
              }
              flushText();
            }
            h.onWorkflowDispatch?.(data);
            break;
          case 'workflow_output_preview':
            h.onWorkflowOutputPreview?.(data);
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
            pendingWorkflowResultRef.current = undefined;
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
  }, [conversationId, flushText]);

  return { connected };
}
