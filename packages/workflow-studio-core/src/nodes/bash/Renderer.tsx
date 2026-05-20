import type { Node as RFNode, NodeProps } from '@xyflow/react';
import type { VariantId } from '../registry';
import type { DagNodeData } from '../shared/types';
import { NodeShell } from '../shared/NodeShell';
import type { BashNodeData } from './data';

type BashFlowNode = RFNode<DagNodeData<BashNodeData>, VariantId>;

export function BashRenderer({ data, selected }: NodeProps<BashFlowNode>): JSX.Element {
  const { node } = data;
  const secondary = node.data.bash ? node.data.bash.slice(0, 32) : undefined;
  return (
    <NodeShell variant="bash" label={node.id} selected={selected ?? false} secondary={secondary} />
  );
}
