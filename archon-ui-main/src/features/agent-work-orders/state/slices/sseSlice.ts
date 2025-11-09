import type { StateCreator } from "zustand";
import type { LogEntry, SSEConnectionState } from "../../types";

export type LiveProgress = {
  currentStep?: string;
  stepNumber?: number;
  totalSteps?: number;
  progressPct?: number;
  elapsedSeconds?: number;
  status?: string;
};

export type SSESlice = {
  // Active EventSource connections (keyed by work_order_id)
  logConnections: Map<string, EventSource>;

  // Connection states
  connectionStates: Record<string, SSEConnectionState>;

  // Live data from SSE (keyed by work_order_id)
  // This OVERLAYS on top of TanStack Query cached data
  liveLogs: Record<string, LogEntry[]>;
  liveProgress: Record<string, LiveProgress>;

  // Actions
  connectToLogs: (workOrderId: string) => void;
  disconnectFromLogs: (workOrderId: string) => void;
  handleLogEvent: (workOrderId: string, log: LogEntry) => void;
  clearLogs: (workOrderId: string) => void;
  disconnectAll: () => void;
};

/**
 * SSE Slice
 *
 * Manages Server-Sent Event connections and real-time data from log streams.
 * Handles connection lifecycle, auto-reconnect, and live data aggregation.
 *
 * Persisted: NO (connections must be re-established on page load)
 *
 * Pattern:
 * 1. Component calls connectToLogs(workOrderId) on mount
 * 2. Zustand creates EventSource if not exists
 * 3. Multiple components can subscribe to same connection
 * 4. handleLogEvent parses logs and updates liveProgress
 * 5. Component calls disconnectFromLogs on unmount
 * 6. Zustand closes EventSource when no more subscribers
 *
 * @example
 * ```typescript
 * // Connect to SSE
 * const connectToLogs = useAgentWorkOrdersStore((s) => s.connectToLogs);
 * const disconnectFromLogs = useAgentWorkOrdersStore((s) => s.disconnectFromLogs);
 *
 * useEffect(() => {
 *   connectToLogs(workOrderId);
 *   return () => disconnectFromLogs(workOrderId);
 * }, [workOrderId]);
 *
 * // Subscribe to live progress
 * const progress = useAgentWorkOrdersStore((s) => s.liveProgress[workOrderId]);
 * ```
 */
export const createSSESlice: StateCreator<SSESlice, [], [], SSESlice> = (set, get) => ({
  // Initial state
  logConnections: new Map(),
  connectionStates: {},
  liveLogs: {},
  liveProgress: {},

  // Actions
  connectToLogs: (workOrderId) => {
    const { logConnections } = get();

    // Don't create duplicate connections
    if (logConnections.has(workOrderId)) {
      return;
    }

    // Set connecting state
    set((state) => ({
      connectionStates: {
        ...state.connectionStates,
        [workOrderId]: "connecting" as SSEConnectionState,
      },
    }));

    // Create EventSource for log stream
    const url = `/api/agent-work-orders/${workOrderId}/logs/stream`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      set((state) => ({
        connectionStates: {
          ...state.connectionStates,
          [workOrderId]: "connected" as SSEConnectionState,
        },
      }));
    };

    eventSource.onmessage = (event) => {
      try {
        const logEntry: LogEntry = JSON.parse(event.data);
        get().handleLogEvent(workOrderId, logEntry);
      } catch (err) {
        console.error("Failed to parse log entry:", err);
      }
    };

    eventSource.onerror = (event) => {
      // Check if this is a 404 (work order doesn't exist)
      // EventSource doesn't give us status code, but we can check if it's a permanent failure
      // by attempting to determine if the server is reachable
      const target = event.target as EventSource;

      // If the EventSource readyState is CLOSED (2), it won't reconnect
      // This typically happens on 404 or permanent errors
      if (target.readyState === EventSource.CLOSED) {
        // Permanent failure (likely 404) - clean up and don't retry
        eventSource.close();
        set((state) => {
          const newConnections = new Map(state.logConnections);
          newConnections.delete(workOrderId);

          // Remove from persisted state too
          const newLiveLogs = { ...state.liveLogs };
          const newLiveProgress = { ...state.liveProgress };
          delete newLiveLogs[workOrderId];
          delete newLiveProgress[workOrderId];

          return {
            logConnections: newConnections,
            liveLogs: newLiveLogs,
            liveProgress: newLiveProgress,
            connectionStates: {
              ...state.connectionStates,
              [workOrderId]: "disconnected" as SSEConnectionState,
            },
          };
        });
        return;
      }

      // Temporary error - retry after 5 seconds
      set((state) => ({
        connectionStates: {
          ...state.connectionStates,
          [workOrderId]: "error" as SSEConnectionState,
        },
      }));

      setTimeout(() => {
        eventSource.close();
        set((state) => {
          const newConnections = new Map(state.logConnections);
          newConnections.delete(workOrderId);
          return { logConnections: newConnections };
        });
        get().connectToLogs(workOrderId); // Retry
      }, 5000);
    };

    // Store connection
    const newConnections = new Map(logConnections);
    newConnections.set(workOrderId, eventSource);
    set({ logConnections: newConnections });
  },

  disconnectFromLogs: (workOrderId) => {
    const { logConnections } = get();
    const connection = logConnections.get(workOrderId);

    if (connection) {
      connection.close();
      const newConnections = new Map(logConnections);
      newConnections.delete(workOrderId);

      set({
        logConnections: newConnections,
        connectionStates: {
          ...get().connectionStates,
          [workOrderId]: "disconnected" as SSEConnectionState,
        },
      });
    }
  },

  handleLogEvent: (workOrderId, log) => {
    // Add to logs array
    set((state) => ({
      liveLogs: {
        ...state.liveLogs,
        [workOrderId]: [...(state.liveLogs[workOrderId] || []), log].slice(-500), // Keep last 500
      },
    }));

    // Parse log to update progress
    const progressUpdate: Partial<LiveProgress> = {};

    if (log.event === "step_started") {
      progressUpdate.currentStep = log.step;
      progressUpdate.stepNumber = log.step_number;
      progressUpdate.totalSteps = log.total_steps;

      // Calculate progress based on COMPLETED steps (current - 1)
      // If on step 3/3, progress is 66% (2 completed), not 100%
      if (log.step_number !== undefined && log.total_steps !== undefined && log.total_steps > 0) {
        const completedSteps = log.step_number - 1; // Steps completed before current
        progressUpdate.progressPct = Math.round((completedSteps / log.total_steps) * 100);
      }
    }

    // step_completed: Increment progress by 1 step
    if (log.event === "step_completed") {
      const currentProgress = get().liveProgress[workOrderId];
      if (currentProgress?.stepNumber !== undefined && currentProgress?.totalSteps !== undefined) {
        const completedSteps = currentProgress.stepNumber; // Current step now complete
        progressUpdate.progressPct = Math.round((completedSteps / currentProgress.totalSteps) * 100);
      }
    }

    if (log.elapsed_seconds !== undefined) {
      progressUpdate.elapsedSeconds = log.elapsed_seconds;
    }

    if (log.event === "workflow_completed") {
      progressUpdate.status = "completed";
      progressUpdate.progressPct = 100; // Ensure 100% on completion
    }

    if (log.event === "workflow_failed" || log.level === "error") {
      progressUpdate.status = "failed";
    }

    if (Object.keys(progressUpdate).length > 0) {
      set((state) => ({
        liveProgress: {
          ...state.liveProgress,
          [workOrderId]: {
            ...state.liveProgress[workOrderId],
            ...progressUpdate,
          },
        },
      }));
    }
  },

  clearLogs: (workOrderId) => {
    set((state) => ({
      liveLogs: {
        ...state.liveLogs,
        [workOrderId]: [],
      },
    }));
  },

  disconnectAll: () => {
    const { logConnections } = get();
    logConnections.forEach((conn) => conn.close());

    set({
      logConnections: new Map(),
      connectionStates: {},
      liveLogs: {},
      liveProgress: {},
    });
  },
});
