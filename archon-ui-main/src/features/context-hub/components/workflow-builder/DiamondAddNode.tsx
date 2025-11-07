/**
 * Diamond Add Node Component
 *
 * A diamond-shaped node with a plus icon for adding additional templates
 * under a type node (like N8n's agent box with multiple tools).
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";

export interface DiamondAddNodeData {
  stepType: "planning" | "implement" | "validate";
  onSelect?: () => void;
}

export function DiamondAddNode({ data }: NodeProps<DiamondAddNodeData>) {
  return (
    <div
      className="relative cursor-pointer group"
      onClick={data.onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          data.onSelect?.();
        }
      }}
    >
      <Handle type="target" position={Position.Top} className="w-2 h-2 bg-gray-400 border border-gray-600" />
      <div className="flex items-center justify-center w-10 h-10 transform rotate-45 border-2 border-dashed border-gray-400 dark:border-gray-500 bg-gray-100/50 dark:bg-gray-800/50 hover:border-cyan-400 dark:hover:border-cyan-500 hover:bg-cyan-500/10 dark:hover:bg-cyan-400/10 transition-all">
        <Plus className="w-5 h-5 text-gray-600 dark:text-gray-400 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transform -rotate-45" />
      </div>
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 bg-gray-400 border border-gray-600" />
    </div>
  );
}

