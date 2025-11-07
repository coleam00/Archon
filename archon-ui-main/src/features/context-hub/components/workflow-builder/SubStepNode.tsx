/**
 * Sub-Step Node Component
 *
 * Child node connected vertically below template nodes with dashed lines.
 * Shows sub-step name and the agent template performing it.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface SubStepNodeData {
  subStepName: string;
  agentName: string;
  order: number;
}

export function SubStepNode({ data }: NodeProps<SubStepNodeData>) {
  return (
    <div className="relative rounded-md border border-gray-400/40 dark:border-gray-500/40 bg-gray-50/30 dark:bg-gray-800/30 backdrop-blur-sm p-2 min-w-[140px] ml-6">
      <Handle type="target" position={Position.Top} className="w-2 h-2 bg-gray-400 border border-gray-600" />
      <div className="text-xs font-medium text-gray-900 dark:text-white">{data.subStepName}</div>
      <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">Agent: {data.agentName}</div>
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 bg-gray-400 border border-gray-600" />
    </div>
  );
}

