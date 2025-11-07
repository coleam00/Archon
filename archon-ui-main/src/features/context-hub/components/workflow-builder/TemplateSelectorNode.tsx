/**
 * Template Selector Node Component
 *
 * Blank/placeholder node that appears below type nodes.
 * When clicked, shows a template selector to choose a step template.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";

export interface TemplateSelectorNodeData {
  stepType: "planning" | "implement" | "validate" | "prime" | "git";
  onSelect?: () => void;
}

export function TemplateSelectorNode({ data }: NodeProps<TemplateSelectorNodeData>) {
  return (
    <div
      className="relative rounded-lg border-2 border-dashed border-gray-400/50 dark:border-gray-500/50 bg-gray-100/20 dark:bg-gray-800/20 backdrop-blur-sm p-3 min-w-[160px] cursor-pointer hover:border-cyan-400/70 hover:bg-cyan-500/10 dark:hover:bg-cyan-400/10 transition-all"
      onClick={data.onSelect}
    >
      <Handle type="target" position={Position.Top} className="w-2 h-2 bg-gray-400 border border-gray-600" />
      <div className="flex items-center justify-center gap-2 text-gray-600 dark:text-gray-400">
        <Plus className="w-4 h-4" />
        <span className="text-sm">Select Template</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 bg-gray-400 border border-gray-600" />
    </div>
  );
}

