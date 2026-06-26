import { useState } from 'react';
import { StatusIcon } from './StatusIcon';
import { formatDurationMs } from '@/lib/format';
import type { DagNodeState, DagTaskInfo, DagHookInfo } from '@/lib/types';

interface DagNodeProgressProps {
  nodes: DagNodeState[];
  activeNodeId: string | null;
  onNodeClick: (nodeId: string) => void;
}

/** Inline badge summarizing a subagent task activity row. The label uses
 *  the AI-generated `summary` when present (more readable than the raw
 *  `description`) and falls back to `description`. */
function TaskActivityLabel({ task }: { task: DagTaskInfo }): string {
  if (task.summary) return task.summary;
  if (task.description) return task.description;
  if (task.taskType) return `${task.taskType} task`;
  return 'Subagent task';
}

function TaskStatusBadge({ task }: { task: DagTaskInfo }): React.ReactElement {
  const cls =
    task.activity === 'completed'
      ? 'text-emerald-400'
      : task.activity === 'failed'
        ? 'text-red-400'
        : task.activity === 'stopped'
          ? 'text-amber-400'
          : 'text-text-secondary';
  return <span className={`text-[10px] uppercase tracking-wide ${cls}`}>{task.activity}</span>;
}

/** Inline indicator for a hook callback — collapses the started/response
 *  pair into a single readable line like
 *  `PreToolUse(Bash) → approved` or `PostToolUse(Edit) → error`. */
function HookIndicator({ hook }: { hook: DagHookInfo }): React.ReactElement {
  const outcomeLabel =
    hook.outcome === 'success'
      ? 'approved'
      : hook.outcome === 'error'
        ? 'error'
        : hook.outcome === 'cancelled'
          ? 'cancelled'
          : 'running…';
  const outcomeColor =
    hook.outcome === 'success'
      ? 'text-emerald-400'
      : hook.outcome === 'error'
        ? 'text-red-400'
        : hook.outcome === 'cancelled'
          ? 'text-amber-400'
          : 'text-text-tertiary';
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary font-mono">
      <span className="text-text-secondary">
        {hook.hookEvent}
        {hook.hookName ? `(${hook.hookName})` : ''}
      </span>
      <span>→</span>
      <span className={outcomeColor}>{outcomeLabel}</span>
      {hook.exitCode !== undefined && (
        <span className="text-text-tertiary">exit {hook.exitCode}</span>
      )}
    </div>
  );
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
  // Phase 3 of #975 — tasks/hooks are collapsible under the parent node.
  // The expand chevron is shown when ANY of iterations/tasks/hooks is
  // populated so the indicator is stable as events stream in.
  const hasTasks = (node.tasks?.length ?? 0) > 0;
  const hasHooks = (node.hooks?.length ?? 0) > 0;
  const hasSubItems = hasIterations || hasTasks || hasHooks;
  // Stable id linking the toggle button to its collapsible region for a11y.
  const subItemsId = `dag-subitems-${node.nodeId}`;

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
          {hasSubItems && (
            <button
              type="button"
              onClick={(e): void => {
                e.stopPropagation();
                setExpanded(prev => !prev);
              }}
              className="text-text-tertiary hover:text-text-secondary shrink-0 text-xs cursor-pointer"
              aria-label={expanded ? 'Collapse details' : 'Expand details'}
              aria-expanded={expanded}
              aria-controls={subItemsId}
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
      {expanded && hasSubItems && (
        <div id={subItemsId} className="ml-6 mt-0.5 space-y-1">
          {hasIterations && (
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary px-2">
                Iterations
              </div>
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
          {hasTasks && (
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary px-2">
                Subagent tasks ({node.tasks?.length ?? 0})
              </div>
              {(node.tasks ?? []).map(task => (
                <div
                  key={task.taskId}
                  className="flex items-center gap-2 px-2 py-1 text-xs"
                  title={task.summary ?? task.description ?? task.taskId}
                >
                  <StatusIcon
                    status={
                      task.activity === 'completed'
                        ? 'completed'
                        : task.activity === 'failed' || task.activity === 'stopped'
                          ? 'failed'
                          : 'running'
                    }
                  />
                  <span className="text-text-secondary flex-1 truncate">
                    <TaskActivityLabel task={task} />
                  </span>
                  <TaskStatusBadge task={task} />
                </div>
              ))}
            </div>
          )}
          {hasHooks && (
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary px-2">
                Hooks ({node.hooks?.length ?? 0})
              </div>
              {(node.hooks ?? []).map(hook => (
                <div key={hook.hookId} className="px-2 py-0.5">
                  <HookIndicator hook={hook} />
                </div>
              ))}
            </div>
          )}
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
