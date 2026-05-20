import { useCallback } from 'react';
import { useBuilderStore } from '../store/builder-store';

/**
 * Returns a stable callback bound to a node id that dispatches
 * `store.updateNodeData(id, patch)`. Inspector tabs call the returned
 * function with any field patch — routing into data/base/unknown happens
 * inside the store action.
 */
export function useInspectorPatch(id: string): (patch: Record<string, unknown>) => void {
  return useCallback(
    (patch: Record<string, unknown>) => {
      useBuilderStore.getState().updateNodeData(id, patch);
    },
    [id]
  );
}
