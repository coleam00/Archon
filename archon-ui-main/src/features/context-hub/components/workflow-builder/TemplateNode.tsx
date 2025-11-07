/**
 * Template Node Component
 *
 * Filled template node showing the selected step template name.
 * If the template has sub-steps, this node will have connection points for sub-step nodes.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface TemplateNodeData {
  templateName: string;
  templateSlug: string;
  hasSubSteps: boolean;
  subStepCount?: number;
}

export function TemplateNode({ data }: NodeProps<TemplateNodeData>) {
  return (
    <div className="relative rounded-lg border-2 border-cyan-500/50 dark:border-cyan-400/40 bg-gradient-to-br from-cyan-500/10 to-blue-500/10 backdrop-blur-xl p-3 min-w-[180px] shadow-md">
      <Handle type="target" position={Position.Top} className="w-3 h-3 bg-cyan-400 border-2 border-cyan-600" />
      <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{data.templateName}</div>
      {data.hasSubSteps && (
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {data.subStepCount || 0} sub-step{data.subStepCount !== 1 ? "s" : ""}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-cyan-400 border-2 border-cyan-600" />
    </div>
  );
}

