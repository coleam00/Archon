import { useCallback, useMemo } from 'react';
import type { Extension } from '@codemirror/state';
import { useBuilderStore } from '../../store/builder-store';
import { whenAutocompleteExtension } from './completions';
import { transitiveUpstream } from './transitiveUpstream';

interface WhenContext {
  upstreamIds: readonly string[];
  outputFormatLookup: (nodeId: string) => Record<string, unknown> | null;
  /**
   * Pre-built CodeMirror extension array containing whenAutocompleteExtension.
   * Stable across renders as long as upstreamIds and outputFormatLookup are.
   */
  extensions: Extension[];
}

/**
 * Hook used by GeneralTab and every variant Inspector that hosts a CmEditor
 * with $-reference autocomplete. Reads from the store directly to avoid
 * prop-drilling through Canvas / WorkflowBuilder / NodeInspector.
 */
export function useWhenContext(forNodeId: string): WhenContext {
  const allNodes = useBuilderStore(s => s.nodes);
  const upstreamIds = useMemo(() => transitiveUpstream(forNodeId, allNodes), [forNodeId, allNodes]);
  const outputFormatLookup = useCallback(
    (nodeId: string) => {
      const n = allNodes.find(x => x.id === nodeId);
      return (n?.base?.output_format as Record<string, unknown> | undefined) ?? null;
    },
    [allNodes]
  );
  const extensions = useMemo(
    () => [whenAutocompleteExtension({ upstreamIds, outputFormatLookup })],
    [upstreamIds, outputFormatLookup]
  );
  return { upstreamIds, outputFormatLookup, extensions };
}
