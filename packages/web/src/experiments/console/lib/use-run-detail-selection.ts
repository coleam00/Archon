import { useCallback, useLayoutEffect } from 'react';
import { useSearchParams } from 'react-router';
import { DETAIL_VIEWS, type DetailView, type NodeFilterOption } from '../components/StreamToolbar';

const VIEW_KEY = 'archon.console.detailView';
const NODE_KEY = 'archon.console.runNodeFilter';
const NODE_SCOPE_KEY = 'archon.console.runNodeFilterScope';

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

// Existing node=all links mean all nodes. The scope disambiguates the valid node ID all.
function readNode(value: string | null, scope: string | null): string | null {
  return value === 'all' && scope !== 'single' ? null : value;
}

function setNode(params: URLSearchParams, node: string | null): void {
  params.set('node', node ?? 'all');
  if (node === 'all') params.set('nodeScope', 'single');
  else params.delete('nodeScope');
}

export function useRunDetailSelection(nodeOptions: NodeFilterOption[], loaded: boolean) {
  const [params, setParams] = useSearchParams();
  const view = parseView(params.get('view') ?? readPreference(VIEW_KEY));
  const explicitNode = params.get('node');
  const requestedNode =
    explicitNode !== null
      ? readNode(explicitNode, params.get('nodeScope'))
      : readNode(readPreference(NODE_KEY), readPreference(NODE_SCOPE_KEY));
  const node =
    explicitNode === null &&
    loaded &&
    requestedNode !== null &&
    !nodeOptions.some(option => option.id === requestedNode)
      ? null
      : requestedNode;

  useLayoutEffect(() => {
    if (params.get('view') !== view || (loaded && explicitNode !== (node ?? 'all'))) {
      const next = new URLSearchParams(params);
      next.set('view', view);
      // Validate a stored node before promoting it to an explicit URL selection.
      if (explicitNode !== null || loaded) setNode(next, node);
      setParams(next, { replace: true });
    }
    writePreference(VIEW_KEY, view);
    if (loaded) {
      writePreference(NODE_KEY, node ?? 'all');
      writePreference(NODE_SCOPE_KEY, node === 'all' ? 'single' : '');
    }
  }, [params, setParams, view, node, loaded, explicitNode]);

  const select = useCallback(
    (nextView: DetailView, nextNode: string | null): void => {
      if (nextView === view && nextNode === node) return;
      const next = new URLSearchParams(params);
      next.set('view', nextView);
      setNode(next, nextNode);
      setParams(next);
    },
    [params, setParams, view, node]
  );

  return { view, selectedNodeId: node, select };
}
