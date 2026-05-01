import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { Loader2, Sparkles, Github, Workflow as WorkflowIcon, Inbox } from 'lucide-react';
import type { CompassGhostFeatureNode, CompassPromoteTarget } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface GhostFeatureNodeData extends CompassGhostFeatureNode {
  isAnnotating?: boolean;
  isPromoting?: boolean;
  onPromote?: (ghostId: string, target: CompassPromoteTarget) => void;
  onReannotate?: (ghostId: string) => void;
  [key: string]: unknown;
}

export type GhostFlowNode = Node<GhostFeatureNodeData>;

const SCOPE_LABEL: Record<NonNullable<CompassGhostFeatureNode['annotation']>['scope'], string> = {
  '1h': '1h',
  'half-day': '½ day',
  'multi-day': 'multi-day',
};

const SCOPE_TINT: Record<NonNullable<CompassGhostFeatureNode['annotation']>['scope'], string> = {
  '1h': 'bg-emerald-500/20 text-emerald-300',
  'half-day': 'bg-amber-500/20 text-amber-300',
  'multi-day': 'bg-rose-500/20 text-rose-300',
};

function driftStripe(score: number): string {
  // 0 = green (aligned), 10 = red (drift)
  if (score <= 3) return 'bg-emerald-500';
  if (score <= 6) return 'bg-amber-500';
  return 'bg-rose-500';
}

function GhostFeatureNodeRender({ data, selected }: NodeProps<GhostFlowNode>): React.ReactElement {
  const a = data.annotation;
  const isStale = !a && !data.isAnnotating;
  return (
    <div
      className={cn(
        'flex w-[220px] flex-col overflow-hidden rounded-lg border-2 border-dashed bg-surface/80 backdrop-blur transition-all',
        selected ? 'border-primary ring-1 ring-primary' : 'border-purple-400/60',
        isStale && 'opacity-60'
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-purple-400" />

      {/* Header: ghost icon + title */}
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-purple-300">
          GHOST
        </span>
        <span className="truncate text-xs font-medium text-text-primary">{data.title}</span>
      </div>

      {/* Annotation overlay */}
      {data.isAnnotating ? (
        <div className="flex items-center gap-1.5 border-t border-border px-2.5 py-2 text-[10px] text-text-tertiary">
          <Loader2 className="h-3 w-3 animate-spin" />
          AI analyzing…
        </div>
      ) : a ? (
        <>
          <div className="flex h-1.5 w-full">
            {/* Drift stripe — 0=full green, 10=full red */}
            <div
              className={cn('h-full transition-all', driftStripe(a.drift_score))}
              style={{ width: `${String((a.drift_score / 10) * 100)}%` }}
              title={`Drift: ${String(a.drift_score)}/10`}
            />
            <div className="h-full flex-1 bg-zinc-800/50" />
          </div>
          <div className="flex flex-col gap-1 border-t border-border px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[9px] font-semibold',
                  SCOPE_TINT[a.scope]
                )}
              >
                {SCOPE_LABEL[a.scope]}
              </span>
              <span className="text-[10px] text-text-tertiary">
                drift {a.drift_score.toFixed(1)}
              </span>
              {a.citations.length > 0 && (
                <span className="text-[10px] text-text-tertiary" title="File citations">
                  · {a.citations.length} cite{a.citations.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className="line-clamp-2 text-[10px] text-text-secondary">{a.why_now}</div>
          </div>
        </>
      ) : (
        <div className="border-t border-border px-2.5 py-2 text-[10px] italic text-text-tertiary">
          No annotation yet
        </div>
      )}

      {/* Promotion actions on selected */}
      {selected && (
        <div className="flex border-t border-border bg-surface/80">
          <PromoteBtn
            disabled={data.isPromoting || !a}
            onClick={(): void => data.onPromote?.(data.id, 'queue')}
            label="Queue"
            icon={Inbox}
            active={data.status === 'queued'}
          />
          <PromoteBtn
            disabled={data.isPromoting || !a}
            onClick={(): void => data.onPromote?.(data.id, 'issue')}
            label="Issue"
            icon={Github}
            active={data.promoted_target === 'issue'}
          />
          <PromoteBtn
            disabled={data.isPromoting || !a}
            onClick={(): void => data.onPromote?.(data.id, 'workflow')}
            label="Plan"
            icon={WorkflowIcon}
            active={data.promoted_target === 'workflow'}
          />
        </div>
      )}

      {/* Re-annotate button when annotation exists */}
      {selected && a && !data.isAnnotating && (
        <button
          type="button"
          onClick={(): void => data.onReannotate?.(data.id)}
          className="flex items-center justify-center gap-1 border-t border-border bg-surface/80 px-2 py-1 text-[10px] text-text-secondary hover:bg-surface hover:text-text-primary"
        >
          <Sparkles className="h-3 w-3" />
          Re-analyze
        </button>
      )}

      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-purple-400" />
    </div>
  );
}

function PromoteBtn({
  disabled,
  onClick,
  label,
  icon: Icon,
  active,
}: {
  disabled?: boolean;
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-1 px-1.5 py-1.5 text-[10px] transition-colors',
        active
          ? 'bg-primary/20 text-primary'
          : disabled
            ? 'cursor-not-allowed text-text-tertiary'
            : 'text-text-secondary hover:bg-surface hover:text-text-primary'
      )}
      title={disabled && !active ? 'Annotate first' : label}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

export const ghostFeatureNode = memo(GhostFeatureNodeRender);
