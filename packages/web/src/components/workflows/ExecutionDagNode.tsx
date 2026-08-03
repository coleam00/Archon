import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import type { DagNodeData } from './DagNodeComponent';
import type { WorkflowStepStatus } from '@/lib/types';
import { formatDurationMs } from '@/lib/format';
import { StatusIcon } from './StatusIcon';

export interface ExecutionNodeData extends DagNodeData {
  status?: WorkflowStepStatus;
  duration?: number;
  error?: string;
  selected?: boolean;
  currentIteration?: number;
  maxIterations?: number;
  /** Phase 3 of #975 — surfaced from `DagNodeState.tasks` / `.hooks` so the
   *  graph card shows at-a-glance subagent / hook activity counts. */
  activeTaskCount?: number;
  totalTaskCount?: number;
  hookCount?: number;
}

export type ExecutionFlowNode = Node<ExecutionNodeData>;

const STATUS_STYLES: Partial<Record<WorkflowStepStatus, string>> = {
  completed: 'border-l-2 border-success bg-success/5',
  running: 'border-l-2 border-accent-bright bg-accent/5 shadow-[0_0_8px_var(--accent)]',
  failed: 'border-l-2 border-error bg-error/5',
  skipped: 'opacity-50 border-l-2 border-border',
};
const DEFAULT_STYLE = 'border-l-2 border-border bg-surface-elevated';

const TYPE_COLORS: Record<string, string> = {
  command: 'text-purple-400',
  prompt: 'text-accent-bright',
  bash: 'text-amber-400',
  loop: 'text-orange-400',
};

const TYPE_LABELS: Record<string, string> = {
  command: 'CMD',
  bash: 'BASH',
  prompt: 'PROMPT',
  loop: 'LOOP',
};

function ExecutionDagNodeRender({ data }: NodeProps<ExecutionFlowNode>): React.ReactElement {
  const style = (data.status && STATUS_STYLES[data.status]) ?? DEFAULT_STYLE;
  const typeLabel = TYPE_LABELS[data.nodeType] ?? 'PROMPT';

  return (
    <div
      className={`rounded-lg border border-border px-3 py-2 min-w-[140px] transition-all duration-300 ${style}${data.selected ? ' ring-2 ring-accent-bright' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-border !w-2 !h-2" />
      <div className="flex items-center gap-2">
        <StatusIcon status={data.status ?? 'pending'} />
        <span
          className={`text-[10px] font-medium ${TYPE_COLORS[data.nodeType] ?? 'text-text-tertiary'}`}
        >
          {typeLabel}
        </span>
        <span className="text-xs font-medium text-text-primary truncate max-w-[100px]">
          {data.label}
        </span>
        {data.duration !== undefined && (
          <span className="text-[10px] text-text-tertiary ml-auto shrink-0">
            {formatDurationMs(data.duration)}
          </span>
        )}
      </div>
      {data.currentIteration !== undefined && data.maxIterations !== undefined && (
        <div className="text-[10px] text-text-tertiary mt-0.5">
          {data.currentIteration}/{data.maxIterations} iterations
        </div>
      )}
      {(data.totalTaskCount !== undefined && data.totalTaskCount > 0) ||
      (data.hookCount !== undefined && data.hookCount > 0) ? (
        <div className="flex items-center gap-2 text-[10px] text-text-tertiary mt-0.5">
          {data.totalTaskCount !== undefined && data.totalTaskCount > 0 && (
            <span title="Subagent tasks">
              {data.activeTaskCount === data.totalTaskCount
                ? `${String(data.totalTaskCount)} task${data.totalTaskCount === 1 ? '' : 's'}`
                : `${String(data.activeTaskCount ?? 0)}/${String(data.totalTaskCount)} tasks`}
            </span>
          )}
          {data.hookCount !== undefined && data.hookCount > 0 && (
            <span title="Hook callbacks">
              {String(data.hookCount)} hook{data.hookCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      ) : null}
      {data.error && (
        <div className="text-[10px] text-error mt-1 truncate" title={data.error}>
          {data.error.slice(0, 60)}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-border !w-2 !h-2" />
    </div>
  );
}

export const executionDagNode = memo(ExecutionDagNodeRender);
