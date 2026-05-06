import { ensureUtc } from '@/lib/format';
import type { WorkflowEventResponse, WorkflowRunResponse } from '@/lib/api';
import type {
  ArtifactType,
  DagNodeState,
  LoopIterationInfo,
  WorkflowState,
  WorkflowStepStatus,
} from '@/lib/types';

export interface WorkflowRunQueryData {
  workflowState: WorkflowState;
  workerPlatformId: string | null;
  parentPlatformId: string | null;
  conversationPlatformId: string | null;
  codebaseId: string | null;
  events: WorkflowEventResponse[];
}

interface WorkflowRunQueryResponse {
  // The API can return a partial payload while React Query is resolving a run transition.
  run?: WorkflowRunResponse | null;
  events: WorkflowEventResponse[];
}

export function buildWorkflowRunQueryData(
  runId: string,
  data: WorkflowRunQueryResponse
): WorkflowRunQueryData {
  if (!data.run) {
    throw new Error(`Workflow run ${runId} was not found`);
  }

  const nodeMap = new Map<string, DagNodeState>();
  for (const event of data.events.filter(ev => ev.event_type.startsWith('node_'))) {
    const nodeId = event.step_name ?? (event.data.nodeId as string) ?? '';
    if (!nodeId) continue;
    const status =
      event.event_type === 'node_started'
        ? 'running'
        : event.event_type === 'node_completed'
          ? 'completed'
          : event.event_type === 'node_failed'
            ? 'failed'
            : 'skipped';
    const existing = nodeMap.get(nodeId);
    if (!existing || status !== 'running') {
      nodeMap.set(nodeId, {
        nodeId,
        name: nodeId,
        status: status as WorkflowStepStatus,
        duration: event.data.duration_ms as number | undefined,
        error: event.data.error as string | undefined,
        reason: event.data.reason as 'when_condition' | 'trigger_rule' | undefined,
      });
    }
  }

  for (const event of data.events.filter(ev => ev.event_type.startsWith('loop_iteration_'))) {
    const nodeId = event.step_name ?? '';
    if (!nodeId) continue;
    const existing = nodeMap.get(nodeId);
    if (!existing) continue;

    const iteration = event.data.iteration as number | undefined;
    const maxIter = event.data.maxIterations as number | undefined;
    if (iteration === undefined) continue;

    let iterStatus: LoopIterationInfo['status'];
    if (event.event_type === 'loop_iteration_started') {
      iterStatus = 'running';
    } else if (event.event_type === 'loop_iteration_completed') {
      iterStatus = 'completed';
    } else {
      iterStatus = 'failed';
    }

    const existingIters: LoopIterationInfo[] = existing.iterations ?? [];
    const iterIdx = existingIters.findIndex(it => it.iteration === iteration);
    const iterState: LoopIterationInfo = {
      iteration,
      status: iterStatus,
      duration: event.data.duration_ms as number | undefined,
    };
    const newIters = [...existingIters];
    if (iterIdx >= 0) {
      newIters[iterIdx] = iterState;
    } else {
      newIters.push(iterState);
    }

    nodeMap.set(nodeId, {
      ...existing,
      currentIteration: iteration,
      maxIterations: maxIter ?? existing.maxIterations,
      iterations: newIters,
    });
  }

  return {
    workflowState: {
      runId: data.run.id,
      workflowName: data.run.workflow_name,
      status: data.run.status,
      dagNodes: Array.from(nodeMap.values()),
      artifacts: data.events
        .filter(event => event.event_type === 'workflow_artifact')
        .map(event => {
          const eventData = event.data;
          return {
            type: (eventData.artifactType as ArtifactType) ?? 'commit',
            label: (eventData.label as string) ?? '',
            url: eventData.url as string | undefined,
            path: eventData.path as string | undefined,
          };
        })
        .filter(artifact => artifact.label || artifact.url || artifact.path),
      startedAt: new Date(ensureUtc(data.run.started_at)).getTime(),
      completedAt: data.run.completed_at
        ? new Date(ensureUtc(data.run.completed_at)).getTime()
        : undefined,
    },
    workerPlatformId: data.run.worker_platform_id ?? null,
    parentPlatformId: data.run.parent_platform_id ?? null,
    conversationPlatformId: data.run.conversation_platform_id ?? null,
    codebaseId: data.run.codebase_id ?? null,
    events: data.events,
  };
}
