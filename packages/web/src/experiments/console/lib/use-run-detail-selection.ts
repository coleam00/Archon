import { useCallback, useLayoutEffect } from 'react';
import { useSearchParams } from 'react-router';
import type { DetailView, NodeFilterOption } from '../components/StreamToolbar';

const VIEW_KEY = 'archon.console.detailView';
const NODE_KEY = 'archon.console.runNodeFilter';

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Browser storage is optional; the URL still owns the selection.
  }
}

function parseView(value: string | null): DetailView {
  return value === 'graph' || value === 'artifacts' ? value : 'log';
}

export function useRunDetailSelection(nodeOptions: NodeFilterOption[], loaded: boolean) {
  const [params, setParams] = useSearchParams();
  const view = parseView(params.get('view') ?? readPreference(VIEW_KEY));
  const requestedNode = params.get('node') ?? readPreference(NODE_KEY) ?? 'all';
  const node =
    loaded && requestedNode !== 'all' && !nodeOptions.some(option => option.id === requestedNode)
      ? 'all'
      : requestedNode;

  useLayoutEffect(() => {
    if (params.get('view') !== view || params.get('node') !== node) {
      const next = new URLSearchParams(params);
      next.set('view', view);
      next.set('node', node);
      setParams(next, { replace: true });
    }
    writePreference(VIEW_KEY, view);
    if (loaded) writePreference(NODE_KEY, node);
  }, [params, setParams, view, node, loaded]);

  const select = useCallback(
    (nextView: DetailView, nextNode: string): void => {
      if (nextView === view && nextNode === node) return;
      const next = new URLSearchParams(params);
      next.set('view', nextView);
      next.set('node', nextNode);
      setParams(next);
    },
    [params, setParams, view, node]
  );

  return { view, selectedNodeId: node, select };
}
