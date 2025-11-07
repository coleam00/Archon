/**
 * Sidebar Repository Card Component
 *
 * Compact version of RepositoryCard for sidebar layout.
 * Shows repository name, pin badge, and inline stat pills.
 */

import { Activity, CheckCircle2, Clock, Copy, Edit, Pin, Trash2 } from "lucide-react";
import { copyToClipboard } from "@/features/shared/utils/clipboard";
import { StatPill } from "@/features/ui/primitives/pill";
import { SelectableCard } from "@/features/ui/primitives/selectable-card";
import { cn } from "@/features/ui/primitives/styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/features/ui/primitives/tooltip";
import { useAgentWorkOrdersStore } from "../state/agentWorkOrdersStore";
import type { ConfiguredRepository } from "../types/repository";

export interface SidebarRepositoryCardProps {
  /** Repository data to display */
  repository: ConfiguredRepository;

  /** Whether this repository is currently selected */
  isSelected?: boolean;

  /** Whether this repository is pinned */
  isPinned?: boolean;

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
 * Static lookup map for background gradient classes
 */
const BACKGROUND_CLASSES = {
  pinned:
    "bg-gradient-to-b from-purple-100/80 via-purple-50/30 to-purple-100/50 dark:from-purple-900/30 dark:via-purple-900/20 dark:to-purple-900/10",
  selected:
    "bg-gradient-to-b from-white/70 via-purple-50/20 to-white/50 dark:from-white/5 dark:via-purple-900/5 dark:to-black/20",
  default: "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30",
} as const;

/**
 * Static lookup map for title text classes
 */
const TITLE_CLASSES = {
  selected: "text-purple-700 dark:text-purple-300",
  default: "text-gray-700 dark:text-gray-300",
} as const;

/**
 * Get background class based on card state
 */
function getBackgroundClass(isPinned: boolean, isSelected: boolean): string {
  if (isPinned) return BACKGROUND_CLASSES.pinned;
  if (isSelected) return BACKGROUND_CLASSES.selected;
  return BACKGROUND_CLASSES.default;
}

/**
 * Get title class based on card state
 */
function getTitleClass(isSelected: boolean): string {
  return isSelected ? TITLE_CLASSES.selected : TITLE_CLASSES.default;
}

export function SidebarRepositoryCard({
  repository,
  isSelected = false,
  isPinned = false,
  showAuroraGlow = false,
  onSelect,
  onDelete,
  stats = { total: 0, active: 0, done: 0 },
}: SidebarRepositoryCardProps) {
  // Get modal action from Zustand store (no prop drilling)
  const openEditRepoModal = useAgentWorkOrdersStore((s) => s.openEditRepoModal);

  const backgroundClass = getBackgroundClass(isPinned, isSelected);
  const titleClass = getTitleClass(isSelected);

  const handleCopyUrl = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await copyToClipboard(repository.repository_url);
    if (result.success) {
      console.log("Repository URL copied to clipboard");
    } else {
      console.error("Failed to copy repository URL:", result.error);
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
      isPinned={isPinned}
      showAuroraGlow={showAuroraGlow}
      onSelect={onSelect}
      size="none"
      blur="md"
      className={cn("p-2 w-56 flex flex-col", backgroundClass)}
    >
      {/* Main content */}
      <div className="space-y-2">
        {/* Title with pin badge - centered */}
        <div className="flex items-center justify-center gap-2">
          <h4 className={cn("font-medium text-sm line-clamp-1 text-center", titleClass)}>
            {repository.display_name || repository.repository_url}
          </h4>
          {isPinned && (
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 bg-purple-500 dark:bg-purple-400 text-white text-[9px] font-bold rounded-full shrink-0"
              aria-label="Pinned repository"
            >
              <Pin className="w-2.5 h-2.5" fill="currentColor" aria-hidden="true" />
            </div>
          )}
        </div>

        {/* Status Pills - all 3 in one row with icons - centered */}
        <div className="flex items-center justify-center gap-1.5">
          <StatPill
            color="pink"
            value={stats.total}
            size="sm"
            icon={<Clock className="w-3 h-3" aria-hidden="true" />}
            aria-label={`${stats.total} total work orders`}
          />
          <StatPill
            color="blue"
            value={stats.active}
            size="sm"
            icon={<Activity className="w-3 h-3" aria-hidden="true" />}
            aria-label={`${stats.active} active work orders`}
          />
          <StatPill
            color="green"
            value={stats.done}
            size="sm"
            icon={<CheckCircle2 className="w-3 h-3" aria-hidden="true" />}
            aria-label={`${stats.done} completed work orders`}
          />
        </div>
      </div>

      {/* Action buttons bar */}
      <div className="flex items-center justify-center gap-2 px-2 py-2 mt-2 border-t border-gray-200/30 dark:border-gray-700/20">
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
