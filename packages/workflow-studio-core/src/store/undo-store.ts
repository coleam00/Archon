import { create } from 'zustand';

export interface UndoSnapshot {
  label: string;
  workflow: unknown;
  nodes: unknown[];
  positions: Record<string, { x: number; y: number }>;
}

interface UndoState {
  past: UndoSnapshot[];
  future: UndoSnapshot[];
  push: (snap: UndoSnapshot) => void;
  undo: () => UndoSnapshot | null;
  redo: () => UndoSnapshot | null;
  clear: () => void;
  nextUndoLabel: () => string | null;
  nextRedoLabel: () => string | null;
}

const MAX_STACK = 50;

export const useUndoStore = create<UndoState>((set, get) => ({
  past: [],
  future: [],
  push: (snap): void => {
    set(s => ({
      past: [...s.past.slice(-(MAX_STACK - 1)), snap],
      future: [],
    }));
  },
  undo: (): UndoSnapshot | null => {
    const { past, future } = get();
    if (past.length === 0) return null;
    const head = past[past.length - 1];
    set({ past: past.slice(0, -1), future: [head, ...future] });
    return head;
  },
  redo: (): UndoSnapshot | null => {
    const { past, future } = get();
    if (future.length === 0) return null;
    const head = future[0];
    set({ past: [...past, head], future: future.slice(1) });
    return head;
  },
  clear: (): void => {
    set({ past: [], future: [] });
  },
  nextUndoLabel: (): string | null => {
    const { past } = get();
    return past.length > 0 ? past[past.length - 1].label : null;
  },
  nextRedoLabel: (): string | null => {
    const { future } = get();
    return future.length > 0 ? future[0].label : null;
  },
}));

// Coalesce window: same label within 400ms → don't push again
let lastLabel = '';
let lastPushTime = 0;
const COALESCE_MS = 400;

export function withUndo(label: string, snap: UndoSnapshot): void {
  const now = Date.now();
  if (label === lastLabel && now - lastPushTime < COALESCE_MS) return;
  lastLabel = label;
  lastPushTime = now;
  useUndoStore.getState().push(snap);
}

/** Reset coalesce state — for test isolation only. */
export function resetCoalesceState(): void {
  lastLabel = '';
  lastPushTime = 0;
}
