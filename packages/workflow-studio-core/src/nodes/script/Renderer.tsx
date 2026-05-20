import type { Node as RFNode, NodeProps } from '@xyflow/react';
import type { VariantId } from '../registry';
import type { DagNodeData } from '../shared/types';
import { NodeShell } from '../shared/NodeShell';
import type { ScriptNodeData } from './data';

type ScriptFlowNode = RFNode<DagNodeData<ScriptNodeData>, VariantId>;

export function ScriptRenderer({ data, selected }: NodeProps<ScriptFlowNode>): JSX.Element {
  const { node } = data;
  const script = typeof node.data.script === 'string' ? node.data.script : '';
  const badge = script ? script.slice(0, 24) : undefined;
  return <NodeShell variant="script" label={node.id} selected={selected ?? false} badge={badge} />;
}
