import { useState } from 'react';
import { StatusIcon } from './StatusIcon';
import { formatDurationMs } from '@/lib/format';
import type { DagNodeState } from '@/lib/types';

interface DagNodeProgressProps {
  nodes: DagNodeState[];
  activeNodeId: string | null;
  onNodeClick: (nodeId: string) => void;
}

function DagNodeItem({
  node,
  isActive,
  onNodeClick,
}: {
  node: DagNodeState;
  isActive: boolean;
  onNodeClick: (nodeId: string) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const hasIterations = (node.iterations?.length ?? 0) > 0;

  return (
    <div>
      <div
        className={`w-full text-left px-2 py-1.5 rounded transition-colors cursor-pointer ${
          isActive ? 'bg-accent/10 border-l-2 border-accent' : 'hover:bg-surface-hover'
        }`}
        onClick={(): void => {
          onNodeClick(node.nodeId);
        }}
        role="row"
      >
        <div className="flex items-center gap-2 text-sm">
          {hasIterations && (
            <button
              type="button"
              onClick={(e): void => {
                e.stopPropagation();
                setExpanded(prev => !prev);
              }}
              className="text-text-tertiary hover:text-text-secondary shrink-0 text-xs cursor-pointer"
              aria-label={expanded ? 'Collapse iterations' : 'Expand iterations'}
            >
              {expanded ? '\u25BC' : '\u25B6'}
            </button>
          )}
          <StatusIcon status={node.status} />
          <span className="truncate flex-1">{node.name}</span>
          {node.currentIteration !== undefined && node.maxIterations !== undefined && (
            <span className="text-xs text-text-secondary shrink-0">
              {node.currentIteration}/{node.maxIterations}
            </span>
          )}
          {node.duration !== undefined && (
            <span className="text-xs text-text-secondary shrink-0">
              {formatDurationMs(node.duration)}
            </span>
          )}
        </div>
        {node.error && (
          <div className="text-xs text-red-400 mt-0.5 ml-6 truncate" title={node.error}>
            {node.error.slice(0, 80)}
          </div>
        )}
        {node.reason && (
          <div className="text-xs text-text-tertiary mt-0.5 ml-6">
            Skipped: {node.reason.replace(/_/g, ' ')}
          </div>
        )}
      </div>
      {expanded && hasIterations && (
        <div className="ml-6 mt-0.5 space-y-0.5">
          {(node.iterations ?? []).map(iter => (
            <div key={iter.iteration} className="flex items-center gap-2 px-2 py-1 text-xs">
              <StatusIcon status={iter.status} />
              <span className="text-text-secondary flex-1">Iteration {iter.iteration}</span>
              {iter.duration !== undefined && (
                <span className="text-text-tertiary">{formatDurationMs(iter.duration)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DagNodeProgress({
  nodes,
  activeNodeId,
  onNodeClick,
}: DagNodeProgressProps): React.ReactElement {
  if (nodes.length === 0) {
    return (
      <div className="p-3 text-xs text-text-secondary italic">No DAG node events recorded.</div>
    );
  }

  return (
    <div className="space-y-1 p-2">
      {nodes.map(node => (
        <DagNodeItem
          key={node.nodeId}
          node={node}
          isActive={node.nodeId === activeNodeId}
          onNodeClick={onNodeClick}
        />
      ))}
    </div>
  );
}
