import { useEffect } from 'react';
import { workflowSSEHandlers } from '@/stores/workflow-store';
import type {
  WorkflowStatusEvent,
  DagNodeEvent,
  WorkflowToolActivityEvent,
  WorkflowTaskActivityEvent,
  WorkflowHookActivityEvent,
  LoopIterationEvent,
} from '@/lib/types';

/** Connects to the multiplexed dashboard SSE stream and routes events to the Zustand store. */
export function useDashboardSSE(): void {
  useEffect(() => {
    const es = new EventSource('/api/stream/__dashboard__');

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
        case 'workflow_task_activity':
          workflowSSEHandlers.onTaskActivity(event as WorkflowTaskActivityEvent);
          break;
        case 'workflow_hook_activity':
          workflowSSEHandlers.onHookActivity(event as WorkflowHookActivityEvent);
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
