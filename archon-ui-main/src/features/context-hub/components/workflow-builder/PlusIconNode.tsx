/**
 * Plus Icon Node Component
 *
 * A clickable plus icon node that appears below type nodes.
 * When clicked, opens the template selector for that step type.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";

export interface PlusIconNodeData {
  stepType: "planning" | "implement" | "validate";
  onSelect?: () => void;
}

export function PlusIconNode({ data }: NodeProps<PlusIconNodeData>) {
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
      <div className="flex items-center justify-center w-8 h-8 rounded-full border-2 border-dashed border-gray-400 dark:border-gray-500 bg-gray-100/50 dark:bg-gray-800/50 hover:border-cyan-400 dark:hover:border-cyan-500 hover:bg-cyan-500/10 dark:hover:bg-cyan-400/10 transition-all">
        <Plus className="w-4 h-4 text-gray-600 dark:text-gray-400 group-hover:text-cyan-600 dark:group-hover:text-cyan-400" />
      </div>
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 bg-gray-400 border border-gray-600" />
    </div>
  );
}

