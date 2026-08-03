import { useCallback, useRef, useState } from 'react';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';
import type { Edge } from '@xyflow/react';

interface UndoState {
  nodes: DagFlowNode[];
  edges: Edge[];
}

interface UndoActions {
  pushSnapshot: (state: UndoState) => void;
  undo: () => UndoState | null;
  redo: () => UndoState | null;
  canUndo: boolean;
  canRedo: boolean;
}

function deepClone(state: UndoState): UndoState {
  return structuredClone(state);
}

export function useBuilderUndo(maxEntries = 100): UndoActions {
  const stackRef = useRef<UndoState[]>([]);
  const cursorRef = useRef<number>(-1);
  // Counter to force re-renders when canUndo/canRedo change
  const [, setVersion] = useState(0);
  const bump = (): void => {
    setVersion(v => v + 1);
  };

  const pushSnapshot = useCallback(
    (state: UndoState): void => {
      const stack = stackRef.current;
      const cursor = cursorRef.current;

      // Truncate any redo history beyond current cursor
      stackRef.current = stack.slice(0, cursor + 1);

      // Append cloned state
      stackRef.current.push(deepClone(state));

      // Enforce max entries via FIFO eviction
      if (stackRef.current.length > maxEntries) {
        stackRef.current = stackRef.current.slice(stackRef.current.length - maxEntries);
      }

      cursorRef.current = stackRef.current.length - 1;
      bump();
    },
    [maxEntries]
  );

  const undo = useCallback((): UndoState | null => {
    if (cursorRef.current <= 0) return null;
    cursorRef.current -= 1;
    bump();
    return deepClone(stackRef.current[cursorRef.current]);
  }, []);

  const redo = useCallback((): UndoState | null => {
    if (cursorRef.current >= stackRef.current.length - 1) return null;
    cursorRef.current += 1;
    bump();
    return deepClone(stackRef.current[cursorRef.current]);
  }, []);

  const canUndo = cursorRef.current > 0;
  const canRedo = cursorRef.current < stackRef.current.length - 1;

  return { pushSnapshot, undo, redo, canUndo, canRedo };
}
