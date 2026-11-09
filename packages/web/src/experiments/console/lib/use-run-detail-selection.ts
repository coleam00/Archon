import { useCallback, useLayoutEffect } from 'react';
import { useSearchParams } from 'react-router';
import { DETAIL_VIEWS, type DetailView, type NodeFilterOption } from '../components/StreamToolbar';

const VIEW_KEY = 'archon.console.detailView';
const NODE_KEY = 'archon.console.runNodeSelection';
const LEGACY_NODE_KEY = 'archon.console.runNodeFilter';

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
  return DETAIL_VIEWS.find(view => view === value) ?? 'log';
}

function readStoredNode(): string | null {
  const selection = readPreference(NODE_KEY);
  if (selection !== null) return selection || null;
  const legacy = readPreference(LEGACY_NODE_KEY);
  return legacy === 'all' ? null : legacy;
}

export function useRunDetailSelection(nodeOptions: NodeFilterOption[], loaded: boolean) {
  const [params, setParams] = useSearchParams();
  const view = parseView(params.get('view') ?? readPreference(VIEW_KEY));
  const explicitNode = params.get('node');
  const requestedNode = explicitNode !== null ? explicitNode || null : readStoredNode();
  const node =
    explicitNode === null &&
    loaded &&
    requestedNode !== null &&
    !nodeOptions.some(option => option.id === requestedNode)
      ? null
      : requestedNode;

  useLayoutEffect(() => {
    if (params.get('view') !== view || (loaded && explicitNode !== (node ?? ''))) {
      const next = new URLSearchParams(params);
      next.set('view', view);
      // Validate a stored node before promoting it to an explicit URL selection.
      if (explicitNode !== null || loaded) next.set('node', node ?? '');
      setParams(next, { replace: true });
    }
    writePreference(VIEW_KEY, view);
    if (loaded) {
      writePreference(NODE_KEY, node ?? '');
    }
  }, [params, setParams, view, node, loaded, explicitNode]);

  const select = useCallback(
    (nextView: DetailView, nextNode: string | null): void => {
      if (nextView === view && nextNode === node) return;
      const next = new URLSearchParams(params);
      next.set('view', nextView);
      next.set('node', nextNode ?? '');
      setParams(next);
    },
    [params, setParams, view, node]
  );

  return { view, selectedNodeId: node, select };
}
