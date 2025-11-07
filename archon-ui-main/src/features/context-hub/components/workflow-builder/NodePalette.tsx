/**
 * Node Palette Component
 *
 * Draggable node palette at the top of the canvas.
 * Shows all available node types that can be added to the workflow.
 */

import { GitBranch, GitCommit, GitPullRequest, Lightbulb, Wrench, CheckCircle2, Sparkles } from "lucide-react";
import { Button } from "@/features/ui/primitives/button";

export interface PaletteNode {
  type: "planning" | "implement" | "validate" | "prime" | "git";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  gitOperation?: "create-branch" | "commit" | "pull-request";
}

const paletteNodes: PaletteNode[] = [
  { type: "prime", label: "Prime", icon: Sparkles },
  { type: "git", label: "Create Branch", icon: GitBranch, gitOperation: "create-branch" },
  { type: "git", label: "Commit", icon: GitCommit, gitOperation: "commit" },
  { type: "git", label: "Pull Request", icon: GitPullRequest, gitOperation: "pull-request" },
];

interface NodePaletteProps {
  onAddNode: (node: PaletteNode) => void;
  disabled?: boolean;
}

export function NodePalette({ onAddNode, disabled = false }: NodePaletteProps) {
  return (
    <div className="flex items-center gap-2 p-3 bg-gray-500/10 dark:bg-gray-400/10 border-b border-gray-500/20 dark:border-gray-400/20 backdrop-blur-sm">
      <span className="text-xs font-medium text-gray-600 dark:text-gray-400 mr-2">Add Node:</span>
      {paletteNodes.map((node, index) => {
        const Icon = node.icon;
        return (
          <Button
            key={index}
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onAddNode(node)}
            disabled={disabled}
            className="gap-2 text-xs"
          >
            <Icon className="w-4 h-4" />
            {node.label}
          </Button>
        );
      })}
    </div>
  );
}

