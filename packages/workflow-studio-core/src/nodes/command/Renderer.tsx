import type { Node as RFNode, NodeProps } from '@xyflow/react';
import type { VariantId } from '../registry';
import type { DagNodeData } from '../shared/types';
import { NodeShell } from '../shared/NodeShell';
import type { CommandNodeData } from './data';

type CommandFlowNode = RFNode<DagNodeData<CommandNodeData>, VariantId>;

export function CommandRenderer({ data, selected }: NodeProps<CommandFlowNode>): JSX.Element {
  const { node } = data;
  const label = node.data.command || node.id;
  return <NodeShell variant="command" label={label} selected={selected ?? false} />;
}
