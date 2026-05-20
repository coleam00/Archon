import type { Node as RFNode, NodeProps } from '@xyflow/react';
import type { VariantId } from '../registry';
import type { DagNodeData } from '../shared/types';
import { NodeShell } from '../shared/NodeShell';
import type { LoopNodeData } from './data';

type LoopFlowNode = RFNode<DagNodeData<LoopNodeData>, VariantId>;

export function LoopRenderer({ data, selected }: NodeProps<LoopFlowNode>): JSX.Element {
  const { node } = data;
  const cfg = node.data.loop ?? ({} as LoopNodeData['loop']);
  const cap = cfg.max_iterations;
  const badge = typeof cap === 'number' ? `cap ${cap}` : 'loop';
  const secondary = cfg.interactive ? 'interactive' : undefined;
  return (
    <NodeShell
      variant="loop"
      label={node.id}
      selected={selected ?? false}
      badge={badge}
      secondary={secondary}
    />
  );
}
