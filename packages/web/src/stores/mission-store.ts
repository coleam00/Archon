/**
 * Mission Control store — separate from workflow-store.ts so mission state
 * doesn't pollute chat/exec views. Holds:
 *
 * - liveRuns: per-run snapshot updated from workflow_status / dag_node events
 * - dispatches: per-dispatch_key snapshot updated from symphony_dispatch_* events
 * - eventTimeline: per-run, capped at 500 entries to bound memory
 */
import { create } from 'zustand';

export type MissionRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused';

export interface MissionRunSnapshot {
  runId: string;
  workflowName: string | null;
  status: MissionRunStatus;
  updatedAt: number;
  error?: string;
}

export type MissionDispatchStatus =
  | 'claimed'
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retry_scheduled';

export interface MissionDispatchSnapshot {
  dispatchKey: string;
  tracker: string;
  identifier: string;
  status: MissionDispatchStatus;
  workflowRunId: string | null;
  codebaseId: string | null;
  workflowName: string | null;
  attempt: number | null;
  retryDueAt: string | null;
  errorMessage: string | null;
  updatedAt: number;
}

export interface MissionTimelineEvent {
  runId: string;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

interface MissionStoreState {
  liveRuns: Map<string, MissionRunSnapshot>;
  dispatches: Map<string, MissionDispatchSnapshot>;
  eventTimeline: Map<string, MissionTimelineEvent[]>;
  /** Flat chronological list across all runs/dispatches. Powers the Feed tab. */
  globalFeed: MissionTimelineEvent[];
  upsertRun: (snapshot: MissionRunSnapshot) => void;
  upsertDispatch: (snapshot: MissionDispatchSnapshot) => void;
  pushTimelineEvent: (event: MissionTimelineEvent) => void;
  pushGlobalEvent: (event: MissionTimelineEvent) => void;
  clear: () => void;
}

const TIMELINE_CAP = 500;
const GLOBAL_FEED_CAP = 1000;

export const useMissionStore = create<MissionStoreState>()(set => ({
  liveRuns: new Map(),
  dispatches: new Map(),
  eventTimeline: new Map(),
  globalFeed: [],

  upsertRun: (snapshot): void => {
    set(state => {
      const next = new Map(state.liveRuns);
      next.set(snapshot.runId, snapshot);
      return { liveRuns: next };
    });
  },

  upsertDispatch: (snapshot): void => {
    set(state => {
      const next = new Map(state.dispatches);
      next.set(snapshot.dispatchKey, snapshot);
      return { dispatches: next };
    });
  },

  pushTimelineEvent: (event): void => {
    set(state => {
      const next = new Map(state.eventTimeline);
      const existing = next.get(event.runId) ?? [];
      const appended = [...existing, event];
      // Keep the most recent TIMELINE_CAP events; oldest fall off the front.
      const trimmed =
        appended.length > TIMELINE_CAP ? appended.slice(appended.length - TIMELINE_CAP) : appended;
      next.set(event.runId, trimmed);
      return { eventTimeline: next };
    });
  },

  pushGlobalEvent: (event): void => {
    set(state => {
      const appended = [...state.globalFeed, event];
      const trimmed =
        appended.length > GLOBAL_FEED_CAP
          ? appended.slice(appended.length - GLOBAL_FEED_CAP)
          : appended;
      return { globalFeed: trimmed };
    });
  },

  clear: (): void => {
    set({
      liveRuns: new Map(),
      dispatches: new Map(),
      eventTimeline: new Map(),
      globalFeed: [],
    });
  },
}));

// ---------------------------------------------------------------------------
// SSE handlers — invoked from useMissionSSE on each parsed event.
// ---------------------------------------------------------------------------

function statusFromWorkflowEvent(evt: { status?: string }): MissionRunStatus | null {
  if (!evt.status) return null;
  if (
    evt.status === 'pending' ||
    evt.status === 'running' ||
    evt.status === 'completed' ||
    evt.status === 'failed' ||
    evt.status === 'cancelled' ||
    evt.status === 'paused'
  ) {
    return evt.status;
  }
  return null;
}

function dispatchStatusFromEventType(type: string): MissionDispatchStatus | null {
  switch (type) {
    case 'symphony_dispatch_claimed':
      return 'claimed';
    case 'symphony_dispatch_started':
      return 'started';
    case 'symphony_dispatch_completed':
      return 'completed';
    case 'symphony_dispatch_failed':
      return 'failed';
    case 'symphony_dispatch_cancelled':
      return 'cancelled';
    case 'symphony_dispatch_retry_scheduled':
      return 'retry_scheduled';
    default:
      return null;
  }
}

interface RawWireEvent {
  type: string;
  runId?: string;
  workflowName?: string;
  status?: string;
  error?: string;
  dispatchKey?: string;
  tracker?: string;
  identifier?: string;
  workflowRunId?: string | null;
  codebaseId?: string | null;
  attempt?: number;
  dueAt?: string;
  errorMessage?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export const missionSSEHandlers = {
  /** Generic dispatcher invoked by useMissionSSE. */
  onEvent(raw: RawWireEvent): void {
    const store = useMissionStore.getState();

    // Heartbeats and other internal SSE chatter shouldn't pollute the feed.
    if (raw.type !== 'heartbeat') {
      store.pushGlobalEvent({
        runId: raw.runId ?? raw.workflowRunId ?? raw.dispatchKey ?? 'system',
        type: raw.type,
        timestamp: raw.timestamp ?? Date.now(),
        payload: { ...raw },
      });
    }

    // Symphony dispatch event handling — keyed on dispatchKey, not runId.
    const dispatchStatus = dispatchStatusFromEventType(raw.type);
    if (dispatchStatus) {
      if (raw.dispatchKey && raw.tracker && raw.identifier) {
        const prev = store.dispatches.get(raw.dispatchKey);
        store.upsertDispatch({
          dispatchKey: raw.dispatchKey,
          tracker: raw.tracker,
          identifier: raw.identifier,
          status: dispatchStatus,
          workflowRunId: raw.workflowRunId ?? prev?.workflowRunId ?? null,
          codebaseId: raw.codebaseId ?? prev?.codebaseId ?? null,
          workflowName: raw.workflowName ?? prev?.workflowName ?? null,
          attempt: typeof raw.attempt === 'number' ? raw.attempt : (prev?.attempt ?? null),
          retryDueAt:
            dispatchStatus === 'retry_scheduled' && raw.dueAt
              ? raw.dueAt
              : (prev?.retryDueAt ?? null),
          errorMessage:
            dispatchStatus === 'failed' && raw.errorMessage
              ? raw.errorMessage
              : (prev?.errorMessage ?? null),
          updatedAt: raw.timestamp ?? Date.now(),
        });
      }
      // Symphony events have no runId yet at claimed; skip timeline push when
      // there's no run to associate. Once a workflow run exists, downstream
      // workflow_status events drive the timeline.
      if (raw.workflowRunId) {
        store.pushTimelineEvent({
          runId: raw.workflowRunId,
          type: raw.type,
          timestamp: raw.timestamp ?? Date.now(),
          payload: { ...raw },
        });
      }
      return;
    }

    // Workflow events — keyed on runId.
    if (!raw.runId) return;

    if (raw.type === 'workflow_status') {
      const status = statusFromWorkflowEvent(raw);
      if (status) {
        store.upsertRun({
          runId: raw.runId,
          workflowName: raw.workflowName ?? null,
          status,
          updatedAt: raw.timestamp ?? Date.now(),
          error: raw.error,
        });
      }
    }

    // Filter timeline pushes to event types that surface in the run drawer.
    const TIMELINE_TYPES = new Set([
      'workflow_status',
      'dag_node',
      'workflow_tool_activity',
      'workflow_step',
      'workflow_artifact',
    ]);
    if (TIMELINE_TYPES.has(raw.type)) {
      store.pushTimelineEvent({
        runId: raw.runId,
        type: raw.type,
        timestamp: raw.timestamp ?? Date.now(),
        payload: { ...raw },
      });
    }
  },
};
