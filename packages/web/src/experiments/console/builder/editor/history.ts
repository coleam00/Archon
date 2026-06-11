/**
 * Pure undo/redo history. Ported from the standalone studio's `undo-store.ts`
 * but framework-agnostic (no zustand): the caller (BuilderPage's reducer)
 * threads `History` values through, and time is an explicit parameter so the
 * coalescing window is deterministic under test.
 *
 * Snapshots are pushed *before* an edit is applied (they capture the pre-edit
 * state); undo restores the last snapshot and parks the caller's current state
 * on the redo stack. Consecutive pushes with the same `kind` inside the
 * ~400ms window coalesce into one entry — the window slides on every attempt,
 * so a continuous drag or burst of typing costs a single undo step.
 */
import type { BuilderWorkflow } from '../types';
import type { XYPosition } from '../flow/types';

/** What one undo step restores: the workflow plus the UI-only position map. */
export interface Snapshot {
  workflow: BuilderWorkflow;
  positions: ReadonlyMap<string, XYPosition>;
}

interface HistoryEntry {
  kind: string;
  snapshot: Snapshot;
}

/** Immutable history value. Create with `createHistory()`. */
export interface History {
  past: readonly HistoryEntry[];
  future: readonly HistoryEntry[];
  /** Kind of the most recent push attempt (for coalescing). */
  lastKind: string | null;
  /** Timestamp of the most recent push attempt (for coalescing). */
  lastTime: number;
}

export const COALESCE_MS = 400;
const MAX_STACK = 50;

/** A fresh, empty history. */
export function createHistory(): History {
  return { past: [], future: [], lastKind: null, lastTime: 0 };
}

/**
 * Record `snapshot` as an undo point for an edit of `kind` happening at `now`.
 * A push with the same kind within {@link COALESCE_MS} of the previous attempt
 * coalesces (no new entry; the earlier snapshot stays the undo point) but
 * still refreshes the window. Any push clears the redo stack.
 */
export function pushSnapshot(h: History, kind: string, snapshot: Snapshot, now: number): History {
  const coalesce = h.lastKind === kind && now - h.lastTime < COALESCE_MS && h.past.length > 0;
  if (coalesce) {
    return { ...h, future: [], lastTime: now };
  }
  return {
    past: [...h.past.slice(-(MAX_STACK - 1)), { kind, snapshot }],
    future: [],
    lastKind: kind,
    lastTime: now,
  };
}

export function canUndo(h: History): boolean {
  return h.past.length > 0;
}

export function canRedo(h: History): boolean {
  return h.future.length > 0;
}

/**
 * Step back. Returns the snapshot to restore plus the next history value, or
 * `null` when there is nothing to undo. `current` (the caller's live state)
 * moves onto the redo stack. Resets the coalescing window so the next edit
 * always gets its own entry.
 */
export function undo(
  h: History,
  current: Snapshot
): { history: History; snapshot: Snapshot } | null {
  const head = h.past[h.past.length - 1];
  if (head === undefined) return null;
  return {
    history: {
      past: h.past.slice(0, -1),
      future: [{ kind: head.kind, snapshot: current }, ...h.future],
      lastKind: null,
      lastTime: 0,
    },
    snapshot: head.snapshot,
  };
}

/**
 * Step forward. Returns the snapshot to restore plus the next history value,
 * or `null` when there is nothing to redo. `current` moves onto the undo stack.
 */
export function redo(
  h: History,
  current: Snapshot
): { history: History; snapshot: Snapshot } | null {
  const head = h.future[0];
  if (head === undefined) return null;
  return {
    history: {
      past: [...h.past, { kind: head.kind, snapshot: current }],
      future: h.future.slice(1),
      lastKind: null,
      lastTime: 0,
    },
    snapshot: head.snapshot,
  };
}
