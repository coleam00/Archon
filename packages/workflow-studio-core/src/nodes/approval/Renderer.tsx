import type { Node as RFNode, NodeProps } from '@xyflow/react';
import type { VariantId } from '../registry';
import type { DagNodeData } from '../shared/types';
import { NodeShell } from '../shared/NodeShell';
import type { ApprovalNodeData } from './data';

type ApprovalFlowNode = RFNode<DagNodeData<ApprovalNodeData>, VariantId>;

export function ApprovalRenderer({ data, selected }: NodeProps<ApprovalFlowNode>): JSX.Element {
  const { node } = data;
  const msg = node.data.approval?.message;
  const secondary = typeof msg === 'string' && msg ? msg.slice(0, 32) : undefined;
  return (
    <NodeShell
      variant="approval"
      label={node.id}
      selected={selected ?? false}
      badge="approval"
      secondary={secondary}
    />
  );
}
