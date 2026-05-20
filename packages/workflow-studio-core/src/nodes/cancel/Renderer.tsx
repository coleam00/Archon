import type { Node as RFNode, NodeProps } from '@xyflow/react';
import type { VariantId } from '../registry';
import type { DagNodeData } from '../shared/types';
import { NodeShell } from '../shared/NodeShell';
import type { CancelNodeData } from './data';

type CancelFlowNode = RFNode<DagNodeData<CancelNodeData>, VariantId>;

export function CancelRenderer({ data, selected }: NodeProps<CancelFlowNode>): JSX.Element {
  const { node } = data;
  return <NodeShell variant="cancel" label={node.id} selected={selected ?? false} badge="cancel" />;
}
