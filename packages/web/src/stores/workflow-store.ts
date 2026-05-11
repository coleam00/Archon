import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { queryClient } from '@/lib/query-client';
import { getWorkflowRun } from '@/lib/api';
import { isTerminalStatus } from '@/lib/workflow-utils';
import type {
  WorkflowState,
  DagNodeState,
  WorkflowStatusEvent,
  WorkflowArtifactEvent,
  DagNodeEvent,
  WorkflowToolActivityEvent,
  LoopIterationEvent,
  LoopIterationInfo,
} from '@/lib/types';

interface WorkflowStoreState {
  workflows: Map<string, WorkflowState>;
  activeWorkflowId: string | null;
  // Actions
  handleWorkflowStatus: (event: WorkflowStatusEvent) => void;
  handleWorkflowArtifact: (event: WorkflowArtifactEvent) => void;
  handleDagNode: (event: DagNodeEvent) => void;
  handleLoopIteration: (event: LoopIterationEvent) => void;
  handleWorkflowToolActivity: (event: WorkflowToolActivityEvent) => void;
  hydrateWorkflow: (state: WorkflowState) => void;
}

// --- Helpers ---

/** Update a single workflow entry in the Map. Returns unchanged state if runId not found. */
function updateWorkflow(
  state: WorkflowStoreState,
  runId: string,
  updater: (wf: WorkflowState) => WorkflowState
): Partial<WorkflowStoreState> | WorkflowStoreState {
  const wf = state.workflows.get(runId);
  if (!wf) return state;
  const next = new Map(state.workflows);
  next.set(runId, updater(wf));
  return { workflows: next };
}

/** Derive the active workflow ID: most recent running, or most recent any. */
function deriveActiveId(workflows: Map<string, WorkflowState>): string | null {
  let running: WorkflowState | null = null;
  let newest: WorkflowState | null = null;
  for (const wf of workflows.values()) {
    if (wf.status === 'running' && (!running || wf.startedAt > running.startedAt)) {
      running = wf;
    }
    if (!newest || wf.startedAt > newest.startedAt) {
      newest = wf;
    }
  }
  return (running ?? newest)?.runId ?? null;
}

// --- Polling infrastructure ---

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null;
let hasRunInitialCheck = false;
let pollingSubscription: (() => void) | null = null;
const pollInFlight = new Set<string>();

function invalidateWorkflowQueries(): void {
  const keys = [
    'workflow-runs',
    'workflowRuns',
    'workflowRun',
    'workflow-runs-status',
    'conversations',
    'workflowMessages',
  ];
  for (const key of keys) {
    queryClient.invalidateQueries({ queryKey: [key] }).catch((err: unknown) => {
      console.warn('[WorkflowStore] Failed to invalidate query cache', {
        queryKey: key,
        error: err instanceof Error ? err.message : err,
      });
    });
  }
}

function checkWorkflowStatus(runId: string): void {
  if (pollInFlight.has(runId)) return;
  pollInFlight.add(runId);
  void getWorkflowRun(runId)
    .then(data => {
      const serverStatus = data.run.status;
      if (isTerminalStatus(serverStatus)) {
        useWorkflowStore.setState(
          state => {
            const existing = state.workflows.get(runId);
            if (existing?.status !== 'running' && existing?.status !== 'pending') return state;
            const next = new Map(state.workflows);
            next.set(runId, {
              ...existing,
              status: serverStatus,
              completedAt: data.run.completed_at
                ? new Date(
                    data.run.completed_at.endsWith('Z')
                      ? data.run.completed_at
                      : data.run.completed_at + 'Z'
                  ).getTime()
                : Date.now(),
            });
            return { workflows: next, activeWorkflowId: deriveActiveId(next) };
          },
          undefined,
          'workflow/pollUpdate'
        );

        invalidateWorkflowQueries();
      }
    })
    .catch((err: unknown) => {
      console.error('[WorkflowStore] Status poll failed', {
        runId,
        errorType: err instanceof Error ? err.constructor.name : typeof err,
        error: err instanceof Error ? err.message : String(err),
      });
      useWorkflowStore.setState(
        state => {
          const existing = state.workflows.get(runId);
          if (existing?.status !== 'running') return state;
          const next = new Map(state.workflows);
          next.set(runId, { ...existing, stale: true });
          return { workflows: next };
        },
        undefined,
        'workflow/pollStale'
      );
    })
    .finally(() => {
      pollInFlight.delete(runId);
    });
}

function hasRunningWorkflow(workflows: Map<string, WorkflowState>): boolean {
  for (const wf of workflows.values()) {
    if (wf.status === 'running') return true;
  }
  return false;
}

function startPolling(): void {
  if (pollingInterval) return;
  pollingInterval = setInterval(() => {
    const { workflows } = useWorkflowStore.getState();
    for (const wf of workflows.values()) {
      if (wf.status === 'running') {
        checkWorkflowStatus(wf.runId);
      }
    }
  }, 15_000);
}

function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (initialCheckTimer) {
    clearTimeout(initialCheckTimer);
    initialCheckTimer = null;
  }
  hasRunInitialCheck = false;
}

// --- Store ---

export const useWorkflowStore = create<WorkflowStoreState>()(
  devtools(
    subscribeWithSelector(set => ({
      workflows: new Map<string, WorkflowState>(),
      activeWorkflowId: null,

      handleWorkflowStatus: (event: WorkflowStatusEvent): void => {
        set(
          state => {
            const next = new Map(state.workflows);
            const existing = next.get(event.runId);

            if (!existing) {
              next.set(event.runId, {
                runId: event.runId,
                workflowName: event.workflowName,
                status: event.status,
                dagNodes: [],
                artifacts: [],
                startedAt: event.timestamp,
                completedAt: isTerminalStatus(event.status) ? event.timestamp : undefined,
                error: event.error,
                approval: event.approval,
                currentTool: null,
              });
            } else {
              // Don't allow a late/replayed SSE event to resurrect a terminal workflow
              if (isTerminalStatus(existing.status) && event.status === 'running') {
                return state;
              }
              next.set(event.runId, {
                ...existing,
                status: event.status,
                error: event.error,
                completedAt: isTerminalStatus(event.status) ? event.timestamp : undefined,
                approval: event.status === 'paused' ? event.approval : undefined,
              });
            }
            return { workflows: next, activeWorkflowId: deriveActiveId(next) };
          },
          undefined,
          'workflow/status'
        );

        if (event.status === 'running' || isTerminalStatus(event.status)) {
          invalidateWorkflowQueries();
        }
      },

      handleWorkflowArtifact: (event: WorkflowArtifactEvent): void => {
        set(
          state =>
            updateWorkflow(state, event.runId, wf => ({
              ...wf,
              artifacts: [
                ...wf.artifacts,
                {
                  type: event.artifactType,
                  label: event.label,
                  url: event.url,
                  path: event.path,
                },
              ],
            })),
          undefined,
          'workflow/artifact'
        );
      },

      handleDagNode: (event: DagNodeEvent): void => {
        set(
          state =>
            updateWorkflow(state, event.runId, wf => {
              const dagNodes = [...wf.dagNodes];
              const existingIdx = dagNodes.findIndex(n => n.nodeId === event.nodeId);

              const nodeState: DagNodeState = {
                ...(existingIdx >= 0 ? dagNodes[existingIdx] : {}), // preserve accumulated iteration state
                nodeId: event.nodeId,
                name: event.name,
                status: event.status,
                duration: event.duration,
                error: event.error,
                reason: event.reason,
              };

              if (existingIdx >= 0) {
                dagNodes[existingIdx] = nodeState;
              } else {
                dagNodes.push(nodeState);
              }

              return { ...wf, dagNodes };
            }),
          undefined,
          'workflow/dagNode'
        );
      },

      handleLoopIteration: (event: LoopIterationEvent): void => {
        if (!event.nodeId) return; // Non-DAG loops have no nodeId — skip
        set(
          state =>
            updateWorkflow(state, event.runId, wf => {
              const dagNodes = [...wf.dagNodes];
              const existingIdx = dagNodes.findIndex(n => n.nodeId === event.nodeId);
              if (existingIdx < 0) return wf; // Node not yet in store — loop iteration may arrive before dag_node event in SSE ordering. Intentional silent drop.

              const existing = dagNodes[existingIdx];
              const iterations: LoopIterationInfo[] = [...(existing.iterations ?? [])];
              const iterIdx = iterations.findIndex(it => it.iteration === event.iteration);
              const iterState: LoopIterationInfo = {
                iteration: event.iteration,
                status: event.status,
                duration: event.duration,
              };
              if (iterIdx >= 0) {
                iterations[iterIdx] = iterState;
              } else {
                iterations.push(iterState);
              }

              dagNodes[existingIdx] = {
                ...existing,
                currentIteration: event.iteration,
                maxIterations: event.total > 0 ? event.total : existing.maxIterations,
                iterations,
              };
              return { ...wf, dagNodes };
            }),
          undefined,
          'workflow/loopIteration'
        );
      },

      handleWorkflowToolActivity: (event: WorkflowToolActivityEvent): void => {
        set(
          state =>
            updateWorkflow(state, event.runId, wf => ({
              ...wf,
              currentTool:
                event.status === 'started'
                  ? { name: event.toolName, status: 'running' }
                  : { name: event.toolName, status: 'completed', durationMs: event.durationMs },
            })),
          undefined,
          'workflow/toolActivity'
        );
      },

      hydrateWorkflow: (incoming: WorkflowState): void => {
        set(
          state => {
            const existing = state.workflows.get(incoming.runId);
            if (existing) {
              if (
                !isTerminalStatus(incoming.status) ||
                (existing.status !== 'running' && existing.status !== 'pending')
              ) {
                return state;
              }
            }
            const next = new Map(state.workflows);
            next.set(incoming.runId, incoming);
            return { workflows: next, activeWorkflowId: deriveActiveId(next) };
          },
          undefined,
          'workflow/hydrate'
        );
      },
    })),
    { name: 'WorkflowStore', enabled: import.meta.env.DEV }
  )
);

// --- Exports ---

// Selector: reads the derived activeWorkflowId and looks up the WorkflowState.
// Only re-renders when activeWorkflowId changes, not on every Map mutation.
export function selectActiveWorkflow(state: WorkflowStoreState): WorkflowState | null {
  if (!state.activeWorkflowId) return null;
  return state.workflows.get(state.activeWorkflowId) ?? null;
}

// Stable SSE handler object — actions are defined once in create(), so references never change.
// Shared by ChatInterface and WorkflowLogs instead of per-component useShallow selectors.
const {
  handleWorkflowStatus,
  handleWorkflowArtifact,
  handleDagNode,
  handleLoopIteration,
  handleWorkflowToolActivity,
} = useWorkflowStore.getState();

export const workflowSSEHandlers = {
  onWorkflowStatus: handleWorkflowStatus,
  onWorkflowArtifact: handleWorkflowArtifact,
  onDagNode: handleDagNode,
  onLoopIteration: handleLoopIteration,
  onToolActivity: handleWorkflowToolActivity,
} as const;

/** Reset store data and clean up polling timers/subscriptions. Use in tests and HMR. */
export function cleanupWorkflowStore(): void {
  stopPolling();
  pollInFlight.clear();
  pollingSubscription?.();
  pollingSubscription = null;
  // Merge instead of replace — preserves action function references
  // so the module-level workflowSSEHandlers const stays valid.
  useWorkflowStore.setState({ workflows: new Map(), activeWorkflowId: null });
  registerPollingSubscription();
}

// --- Polling lifecycle ---

function registerPollingSubscription(): void {
  pollingSubscription = useWorkflowStore.subscribe(
    state => hasRunningWorkflow(state.workflows),
    hasRunning => {
      if (hasRunning) {
        startPolling();
        if (!hasRunInitialCheck) {
          hasRunInitialCheck = true;
          initialCheckTimer = setTimeout(() => {
            const { workflows } = useWorkflowStore.getState();
            for (const wf of workflows.values()) {
              if (wf.status === 'running') {
                checkWorkflowStatus(wf.runId);
              }
            }
          }, 2_000);
        }
      } else {
        stopPolling();
      }
    }
  );
}

// Initial subscription: auto-start/stop polling whenever a running workflow appears.
// cleanupWorkflowStore() tears down and re-registers this after reset.
registerPollingSubscription();
