/**
 * Custom xyflow node renderer for builder nodes. Follows the production
 * `DagNodeComponent` layout (left color stripe, badge, label, content
 * preview) restyled with console tokens; the stripe and badge colors come
 * from the `--node-<variant>` CSS variables so all seven variants render a
 * distinct identity without hard-coded hex.
 */
import { memo, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { VARIANT_REGISTRY } from '../variants';
import type { BuilderNode } from '../types';
import type { BuilderFlowNode } from '../flow/types';

/** First line of the node's main content, for the in-node preview. */
export function contentPreview(node: BuilderNode): string {
  switch (node.variant) {
    case 'prompt':
      return node.data.prompt.split('\n')[0] ?? '';
    case 'command':
      return node.data.command;
    case 'bash':
      return node.data.bash.split('\n')[0] ?? '';
    case 'script':
      return node.data.script.split('\n')[0] ?? '';
    case 'loop':
      return node.data.prompt.split('\n')[0] ?? '';
    case 'approval':
      return node.data.message.split('\n')[0] ?? '';
    case 'cancel':
      return node.data.reason.split('\n')[0] ?? '';
  }
}

function BuilderNodeRender({ data, selected }: NodeProps<BuilderFlowNode>): ReactElement {
  const node = data.node;
  const capabilities = VARIANT_REGISTRY[node.variant].capabilities;
  const preview = contentPreview(node);
  const stripeStyle: CSSProperties = { background: `var(--node-${node.variant})` };
  const badgeStyle: CSSProperties = {
    color: `var(--node-${node.variant})`,
    background: `color-mix(in oklch, var(--node-${node.variant}), transparent 85%)`,
  };
  const hasWhen = typeof node.base.when === 'string' && node.base.when.length > 0;

  return (
    <div
      className={`flex w-[180px] cursor-pointer overflow-hidden rounded-lg border bg-surface transition-all ${
        selected ? 'border-accent-bright ring-1 ring-accent-bright' : 'border-border'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-accent" />

      <div aria-hidden className="w-[3px] shrink-0" style={stripeStyle} />

      <div className="min-w-0 flex-1 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase"
            style={badgeStyle}
          >
            {data.label}
          </span>
          <span className="truncate font-mono text-xs font-medium text-text-primary">
            {node.id}
          </span>
        </div>

        {preview.length > 0 ? (
          <div className="mb-1 truncate font-mono text-[10px] text-text-tertiary">{preview}</div>
        ) : null}

        <div className="flex flex-wrap gap-1">
          {node.base.model !== undefined ? <Pill>{node.base.model}</Pill> : null}
          {hasWhen ? <Pill>when</Pill> : null}
          {node.base.trigger_rule !== undefined && node.base.trigger_rule !== 'all_success' ? (
            <Pill>{node.base.trigger_rule}</Pill>
          ) : null}
          {capabilities.requiresInteractive === true ? <Pill>interactive</Pill> : null}
          {node.base.output_format !== undefined ? <Pill>{'{}'} JSON</Pill> : null}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-accent" />
    </div>
  );
}

function Pill({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="inline-flex items-center rounded bg-surface-inset px-1.5 py-0.5 text-[9px] font-medium text-text-secondary">
      {children}
    </span>
  );
}

/** memo() for React Flow render performance. */
export const builderNodeView = memo(BuilderNodeRender);
