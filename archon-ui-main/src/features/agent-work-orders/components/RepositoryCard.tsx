/**
 * Repository Card Component
 *
 * Displays a configured repository with custom stat pills matching the example layout.
 * Uses SelectableCard primitive with glassmorphism styling.
 */

import { Activity, CheckCircle2, Clock, Copy, Edit, Trash2 } from "lucide-react";
import { SelectableCard } from "@/features/ui/primitives/selectable-card";
import { cn } from "@/features/ui/primitives/styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/features/ui/primitives/tooltip";
import { useAgentWorkOrdersStore } from "../state/agentWorkOrdersStore";
import type { ConfiguredRepository } from "../types/repository";

export interface RepositoryCardProps {
  /** Repository data to display */
  repository: ConfiguredRepository;

  /** Whether this repository is currently selected */
  isSelected?: boolean;

  /** Whether to show aurora glow effect (when selected) */
  showAuroraGlow?: boolean;

  /** Callback when repository is selected */
  onSelect?: () => void;

  /** Callback when delete button is clicked */
  onDelete?: () => void;

  /** Work order statistics for this repository */
  stats?: {
    total: number;
    active: number;
    done: number;
  };
}

/**
 * Get background class based on card state
 */
function getBackgroundClass(isSelected: boolean): string {
  if (isSelected) {
    return "bg-gradient-to-b from-white/70 via-purple-50/20 to-white/50 dark:from-white/5 dark:via-purple-900/5 dark:to-black/20";
  }
  return "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30";
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error("Failed to copy:", err);
    return false;
  }
}

export function RepositoryCard({
  repository,
  isSelected = false,
  showAuroraGlow = false,
  onSelect,
  onDelete,
  stats = { total: 0, active: 0, done: 0 },
}: RepositoryCardProps) {
  // Get modal action from Zustand store (no prop drilling)
  const openEditRepoModal = useAgentWorkOrdersStore((s) => s.openEditRepoModal);

  const backgroundClass = getBackgroundClass(isSelected);

  const handleCopyUrl = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const success = await copyToClipboard(repository.repository_url);
    if (success) {
      // Could add toast notification here
      console.log("Repository URL copied to clipboard");
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    openEditRepoModal(repository);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) {
      onDelete();
    }
  };

  return (
    <SelectableCard
      isSelected={isSelected}
      isPinned={false}
      showAuroraGlow={showAuroraGlow}
      onSelect={onSelect}
      size="none"
      blur="xl"
      className={cn("w-72 min-h-[180px] flex flex-col shrink-0", backgroundClass)}
    >
      {/* Main content */}
      <div className="flex-1 min-w-0 p-3 pb-2">
        {/* Title */}
        <div className="flex flex-col items-center justify-center mb-4 min-h-[48px]">
          <h3
            className={cn(
              "font-medium text-center leading-tight line-clamp-2 transition-all duration-300",
              isSelected
                ? "text-gray-900 dark:text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                : "text-gray-500 dark:text-gray-400",
            )}
          >
            {repository.display_name || repository.repository_url.replace("https://github.com/", "")}
          </h3>
        </div>

        {/* Work order count pills - 3 custom pills with icons */}
        <div className="flex items-stretch gap-2 w-full">
          {/* Total pill */}
          <div className="relative flex-1 min-w-0">
            <div
              className={cn(
                "absolute inset-0 bg-pink-600 dark:bg-pink-400 rounded-full blur-md",
                isSelected ? "opacity-30 dark:opacity-75" : "opacity-0",
              )}
            />
            <div
              className={cn(
                "relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
                isSelected
                  ? "bg-white/70 dark:bg-zinc-900/90 border-pink-300 dark:border-pink-500/50 dark:shadow-[0_0_10px_rgba(236,72,153,0.5)]"
                  : "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50",
              )}
            >
              <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                <Clock
                  className={cn(
                    "w-4 h-4",
                    isSelected ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600",
                  )}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    "text-[8px] font-medium",
                    isSelected ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  Total
                </span>
              </div>
              <div className="flex-1 min-w-0 flex items-center justify-center border-l border-pink-300 dark:border-pink-500/30">
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {stats.total}
                </span>
              </div>
            </div>
          </div>

          {/* In Progress pill */}
          <div className="relative flex-1 min-w-0">
            <div
              className={cn(
                "absolute inset-0 bg-blue-600 dark:bg-blue-400 rounded-full blur-md",
                isSelected ? "opacity-30 dark:opacity-75" : "opacity-0",
              )}
            />
            <div
              className={cn(
                "relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
                isSelected
                  ? "bg-white/70 dark:bg-zinc-900/90 border-blue-300 dark:border-blue-500/50 dark:shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                  : "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50",
              )}
            >
              <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                <Activity
                  className={cn(
                    "w-4 h-4",
                    isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600",
                  )}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    "text-[8px] font-medium",
                    isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  Active
                </span>
              </div>
              <div className="flex-1 min-w-0 flex items-center justify-center border-l border-blue-300 dark:border-blue-500/30">
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {stats.active}
                </span>
              </div>
            </div>
          </div>

          {/* Completed pill */}
          <div className="relative flex-1 min-w-0">
            <div
              className={cn(
                "absolute inset-0 bg-green-600 dark:bg-green-400 rounded-full blur-md",
                isSelected ? "opacity-30 dark:opacity-75" : "opacity-0",
              )}
            />
            <div
              className={cn(
                "relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
                isSelected
                  ? "bg-white/70 dark:bg-zinc-900/90 border-green-300 dark:border-green-500/50 dark:shadow-[0_0_10px_rgba(34,197,94,0.5)]"
                  : "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50",
              )}
            >
              <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                <CheckCircle2
                  className={cn(
                    "w-4 h-4",
                    isSelected ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600",
                  )}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    "text-[8px] font-medium",
                    isSelected ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  Done
                </span>
              </div>
              <div className="flex-1 min-w-0 flex items-center justify-center border-l border-green-300 dark:border-green-500/30">
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {stats.done}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Verification status */}
        {repository.is_verified && (
          <div className="flex justify-center mt-3">
            <span className="text-xs text-green-600 dark:text-green-400">✓ Verified</span>
          </div>
        )}
      </div>

      {/* Bottom bar with action icons */}
      <div className="flex items-center justify-end gap-2 px-3 py-2 mt-auto border-t border-gray-200/30 dark:border-gray-700/20">
        <TooltipProvider>
          {/* Edit button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleEdit}
                className="p-1.5 rounded-md hover:bg-purple-500/10 dark:hover:bg-purple-500/20 text-gray-500 dark:text-gray-400 hover:text-purple-500 dark:hover:text-purple-400 transition-colors"
                aria-label="Edit repository"
              >
                <Edit className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>

          {/* Copy URL button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopyUrl}
                className="p-1.5 rounded-md hover:bg-cyan-500/10 dark:hover:bg-cyan-500/20 text-gray-500 dark:text-gray-400 hover:text-cyan-500 dark:hover:text-cyan-400 transition-colors"
                aria-label="Copy repository URL"
              >
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Copy URL</TooltipContent>
          </Tooltip>

          {/* Delete button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleDelete}
                className="p-1.5 rounded-md hover:bg-red-500/10 dark:hover:bg-red-500/20 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                aria-label="Delete repository"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </SelectableCard>
  );
}
