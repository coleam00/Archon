import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import type { DagNode } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface DagNodeData extends DagNode {
  /** For command nodes: the command name. For prompt nodes: display label ("Prompt"). For bash: display label ("Shell"). */
  label: string;
  nodeType: 'command' | 'prompt' | 'bash';
  promptText?: string;
  bashScript?: string;
  bashTimeout?: number;
  /** Required by React Flow's Node<T> constraint — do not rely on this for typed access. */
  [key: string]: unknown;
}

export type DagFlowNode = Node<DagNodeData>;

const TYPE_CONFIG = {
  command: {
    badge: 'CMD',
    stripeColor: 'bg-node-command',
    badgeBg: 'bg-node-command/20',
    badgeText: 'text-node-command',
  },
  prompt: {
    badge: 'PROMPT',
    stripeColor: 'bg-node-prompt',
    badgeBg: 'bg-node-prompt/20',
    badgeText: 'text-node-prompt',
  },
  bash: {
    badge: 'BASH',
    stripeColor: 'bg-node-bash',
    badgeBg: 'bg-node-bash/20',
    badgeText: 'text-node-bash',
  },
} as const;

function getContentPreview(data: DagNodeData): string {
  switch (data.nodeType) {
    case 'command':
      return data.label;
    case 'prompt':
      return data.promptText?.split('\n')[0] ?? '';
    case 'bash':
      return data.bashScript?.split('\n')[0] ?? '';
  }
}

function MetadataPill({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-surface-inset text-text-secondary">
      {children}
    </span>
  );
}

function DagNodeRender({ data, selected }: NodeProps<DagFlowNode>): React.ReactElement {
  const config = TYPE_CONFIG[data.nodeType];
  const preview = getContentPreview(data);
  const hasPills =
    data.model ||
    data.output_format ||
    data.when ||
    (data.trigger_rule && data.trigger_rule !== 'all_success') ||
    (data.skills && data.skills.length > 0) ||
    data.mcp;

  return (
    <div
      className={cn(
        'w-[180px] bg-surface border border-border rounded-lg overflow-hidden cursor-pointer transition-all flex',
        selected && 'border-primary ring-1 ring-primary'
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-accent !w-2 !h-2" />

      {/* Left color stripe */}
      <div className={cn('w-[3px] shrink-0', config.stripeColor)} />

      {/* Content area */}
      <div className="flex-1 min-w-0 px-2.5 py-2">
        {/* Header: badge + label */}
        <div className="flex items-center gap-1.5 mb-1">
          <span
            className={cn(
              'text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0',
              config.badgeBg,
              config.badgeText
            )}
          >
            {config.badge}
          </span>
          <span className="text-xs font-medium text-text-primary truncate">{data.label}</span>
        </div>

        {/* Content preview */}
        {preview && (
          <div className="text-[10px] font-mono text-text-tertiary truncate mb-1">{preview}</div>
        )}

        {/* Metadata pills */}
        {hasPills && (
          <div className="flex flex-wrap gap-1">
            {data.model && <MetadataPill>{data.model}</MetadataPill>}
            {data.output_format && <MetadataPill>{'{}'} JSON</MetadataPill>}
            {data.when && <MetadataPill>when</MetadataPill>}
            {data.trigger_rule && data.trigger_rule !== 'all_success' && (
              <MetadataPill>{data.trigger_rule}</MetadataPill>
            )}
            {data.skills && data.skills.length > 0 && <MetadataPill>skills</MetadataPill>}
            {data.mcp && <MetadataPill>mcp</MetadataPill>}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-accent !w-2 !h-2" />
    </div>
  );
}

// memo() for React Flow performance; exported as a named function component
export const dagNodeComponent = memo(DagNodeRender);
