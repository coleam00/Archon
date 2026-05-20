import type { Node as RFNode, NodeProps } from '@xyflow/react';
import type { VariantId } from '../registry';
import type { DagNodeData } from '../shared/types';
import { NodeShell } from '../shared/NodeShell';
import type { PromptNodeData } from './data';

type PromptFlowNode = RFNode<DagNodeData<PromptNodeData>, VariantId>;

export function PromptRenderer({ data, selected }: NodeProps<PromptFlowNode>): JSX.Element {
  const { node } = data;
  const secondary = node.data.prompt ? node.data.prompt.slice(0, 32) : undefined;
  return (
    <NodeShell
      variant="prompt"
      label={node.id}
      selected={selected ?? false}
      secondary={secondary}
    />
  );
}
