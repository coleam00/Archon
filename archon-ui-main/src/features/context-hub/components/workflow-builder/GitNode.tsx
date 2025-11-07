/**
 * Git Node Component
 *
 * Node for Git operations (create branch, commit, pull request).
 * Can be positioned before/after type nodes.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { GitBranch, GitCommit, GitPullRequest } from "lucide-react";

export interface GitNodeData {
  operation: "create-branch" | "commit" | "pull-request";
  label: string;
}

const gitOperationConfig = {
  "create-branch": {
    label: "Create Branch",
    icon: GitBranch,
    gradient: "from-green-500/20 to-emerald-500/20",
    border: "border-green-500/50 dark:border-green-400/40",
    text: "text-green-700 dark:text-green-300",
  },
  commit: {
    label: "Commit",
    icon: GitCommit,
    gradient: "from-cyan-500/20 to-blue-500/20",
    border: "border-cyan-500/50 dark:border-cyan-400/40",
    text: "text-cyan-700 dark:text-cyan-300",
  },
  "pull-request": {
    label: "Pull Request",
    icon: GitPullRequest,
    gradient: "from-purple-500/20 to-pink-500/20",
    border: "border-purple-500/50 dark:border-purple-400/40",
    text: "text-purple-700 dark:text-purple-300",
  },
};

export function GitNode({ data }: NodeProps<GitNodeData>) {
  const config = gitOperationConfig[data.operation];
  const Icon = config.icon;

  return (
    <div
      className={`relative rounded-lg border-2 ${config.border} bg-gradient-to-br ${config.gradient} backdrop-blur-xl p-3 min-w-[160px] shadow-md`}
    >
      <Handle type="target" position={Position.Left} className="w-3 h-3 bg-cyan-400 border-2 border-cyan-600" />
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${config.text}`} />
        <div className={`text-sm font-medium ${config.text}`}>{config.label}</div>
      </div>
      <Handle type="source" position={Position.Right} className="w-3 h-3 bg-cyan-400 border-2 border-cyan-600" />
    </div>
  );
}

