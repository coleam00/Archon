/**
 * Type Node Component
 *
 * Represents a workflow step type (Planning, Implement, Validate).
 * These are top-level category nodes that contain template selector nodes.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface TypeNodeData {
  stepType: "planning" | "implement" | "validate";
  label: string;
}

const stepTypeConfig = {
  planning: {
    label: "Planning",
    gradient: "from-purple-500/20 to-pink-500/20",
    border: "border-purple-500/50 dark:border-purple-400/40",
    text: "text-purple-700 dark:text-purple-300",
  },
  implement: {
    label: "Implement",
    gradient: "from-blue-500/20 to-cyan-500/20",
    border: "border-blue-500/50 dark:border-blue-400/40",
    text: "text-blue-700 dark:text-blue-300",
  },
  validate: {
    label: "Validate",
    gradient: "from-green-500/20 to-emerald-500/20",
    border: "border-green-500/50 dark:border-green-400/40",
    text: "text-green-700 dark:text-green-300",
  },
};

export function TypeNode({ data }: NodeProps<TypeNodeData>) {
  const config = stepTypeConfig[data.stepType];

  return (
    <div
      className={`relative rounded-lg border-2 ${config.border} bg-gradient-to-br ${config.gradient} backdrop-blur-xl p-4 min-w-[180px] shadow-lg`}
    >
      <Handle type="target" position={Position.Left} className="w-3 h-3 bg-cyan-400 border-2 border-cyan-600" />
      <div className={`font-semibold text-lg ${config.text}`}>{config.label}</div>
      <Handle type="source" position={Position.Right} className="w-3 h-3 bg-cyan-400 border-2 border-cyan-600" />
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 bg-gray-400 border border-gray-600" />
    </div>
  );
}

