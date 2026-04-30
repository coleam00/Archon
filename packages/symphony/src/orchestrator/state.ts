import type { Issue } from '../tracker/types';
import type { TrackerKind } from '../config/snapshot';

/**
 * In-memory entry for an issue currently being dispatched. Phase 2 keeps
 * this thin: there is no agent worker, no codex/claude session, no
 * publisher. Phase 3 will re-add fields that link a dispatched entry to
 * an Archon workflow run.
 */
export interface RunningEntry {
  dispatch_key: string;
  tracker: TrackerKind;
  issue_id: string;
  identifier: string;
  issue: Issue;
  started_at: number;
  retry_attempt: number | null;
  /** AbortController used to cancel any in-flight async work on stop(). */
  abort: AbortController;
  cancel_requested: boolean;
}

export interface RetryEntry {
  dispatch_key: string;
  tracker: TrackerKind;
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: ReturnType<typeof setTimeout> | null;
  error: string | null;
  delay_type: 'continuation' | 'failure';
}

/**
 * All sets/maps key on `dispatch_key` (`<tracker>:<identifier>`) so the same
 * raw issue id from two trackers cannot collide.
 */
export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
}

export function createInitialState(): OrchestratorState {
  return {
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
  };
}

export function nowMs(): number {
  return Date.now();
}

export function nowIso(ts: number = nowMs()): string {
  return new Date(ts).toISOString();
}

export function buildDispatchKey(tracker: TrackerKind, identifier: string): string {
  return `${tracker}:${identifier}`;
}
