import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { Code2, GitBranch, Workflow as WorkflowIcon, Component, Box } from 'lucide-react';
import type { CompassRealFeatureNode } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface RealFeatureNodeData extends CompassRealFeatureNode {
  highlighted?: boolean;
  [key: string]: unknown;
}

export type RealFlowNode = Node<RealFeatureNodeData>;

interface KindStyle {
  icon: React.ComponentType<{ className?: string }>;
  badge: string;
  stripe: string;
  badgeBg: string;
  badgeText: string;
}

const KIND_STYLES: Record<CompassRealFeatureNode['kind'], KindStyle> = {
  route: {
    icon: GitBranch,
    badge: 'ROUTE',
    stripe: 'bg-blue-500',
    badgeBg: 'bg-blue-500/15',
    badgeText: 'text-blue-300',
  },
  endpoint: {
    icon: Code2,
    badge: 'API',
    stripe: 'bg-emerald-500',
    badgeBg: 'bg-emerald-500/15',
    badgeText: 'text-emerald-300',
  },
  workflow: {
    icon: WorkflowIcon,
    badge: 'FLOW',
    stripe: 'bg-violet-500',
    badgeBg: 'bg-violet-500/15',
    badgeText: 'text-violet-300',
  },
  component: {
    icon: Component,
    badge: 'UI',
    stripe: 'bg-amber-500',
    badgeBg: 'bg-amber-500/15',
    badgeText: 'text-amber-300',
  },
  module: {
    icon: Box,
    badge: 'MOD',
    stripe: 'bg-zinc-500',
    badgeBg: 'bg-zinc-500/15',
    badgeText: 'text-zinc-300',
  },
};

function RealFeatureNodeRender({ data, selected }: NodeProps<RealFlowNode>): React.ReactElement {
  const style = KIND_STYLES[data.kind];
  return (
    <div
      className={cn(
        'flex w-[180px] cursor-pointer overflow-hidden rounded-lg border bg-surface transition-all',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border',
        data.highlighted && 'ring-2 ring-amber-400/60 shadow-lg shadow-amber-500/10'
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-accent" />
      <div className={cn('w-[3px] shrink-0', style.stripe)} />
      <div className="min-w-0 flex-1 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold',
              style.badgeBg,
              style.badgeText
            )}
          >
            {style.badge}
          </span>
          <style.icon className="h-3 w-3 shrink-0 text-text-tertiary" />
          <span className="truncate text-xs font-medium text-text-primary">{data.label}</span>
        </div>
        <div className="truncate font-mono text-[10px] text-text-tertiary">{data.filePath}</div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-accent" />
    </div>
  );
}

export const realFeatureNode = memo(RealFeatureNodeRender);
