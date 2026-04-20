import { useEffect } from 'react';
import { workflowSSEHandlers } from '@/stores/workflow-store';
import { SSE_BASE_URL } from '@/lib/api';
import type {
  WorkflowStatusEvent,
  DagNodeEvent,
  WorkflowToolActivityEvent,
  LoopIterationEvent,
} from '@/lib/types';

/** Connects to the multiplexed dashboard SSE stream and routes events to the Zustand store. */
export function useDashboardSSE(): void {
  useEffect(() => {
    // Use SSE_BASE_URL to bypass the Vite dev proxy (which buffers SSE responses).
    // Mirrors the same pattern used in useSSE.ts for conversation streams.
    const es = new EventSource(`${SSE_BASE_URL}/api/stream/__dashboard__`);

    es.onmessage = (e: MessageEvent<string>): void => {
      let event: { type: string };
      try {
        event = JSON.parse(e.data) as { type: string };
      } catch {
        return;
      }

      switch (event.type) {
        case 'workflow_status':
          workflowSSEHandlers.onWorkflowStatus(event as WorkflowStatusEvent);
          break;
        case 'dag_node':
          workflowSSEHandlers.onDagNode(event as DagNodeEvent);
          break;
        case 'workflow_tool_activity':
          workflowSSEHandlers.onToolActivity(event as WorkflowToolActivityEvent);
          break;
        case 'workflow_step':
          workflowSSEHandlers.onLoopIteration(event as LoopIterationEvent);
          break;
        // heartbeat — ignore
      }
    };

    es.onerror = (): void => {
      // EventSource auto-reconnects on error; no explicit handling needed
    };

    return (): void => {
      es.close();
    };
  }, []); // mount once — stable handlers from Zustand module level
}
