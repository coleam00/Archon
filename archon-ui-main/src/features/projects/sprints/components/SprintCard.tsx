import { Calendar, Target, Trash2 } from "lucide-react";
import { Button } from "../../../ui/primitives";
import { cn } from "../../../ui/primitives/styles";
import type { Sprint, SprintStatus } from "../types";

interface SprintCardProps {
  sprint: Sprint;
  taskCount?: number;
  onDelete: (sprintId: string) => void;
}

const STATUS_CONFIG: Record<SprintStatus, { label: string; className: string }> = {
  planning: {
    label: "Planning",
    className: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  },
  active: {
    label: "Active",
    className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  },
  completed: {
    label: "Completed",
    className: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-gray-100 text-gray-500 dark:bg-gray-800/50 dark:text-gray-400",
  },
};

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function SprintCard({ sprint, taskCount, onDelete }: SprintCardProps) {
  const statusCfg = STATUS_CONFIG[sprint.status];

  return (
    <div
      className={cn(
        "group rounded-lg p-4",
        "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30",
        "border border-gray-200 dark:border-zinc-800/50",
        "shadow-sm hover:shadow-md transition-shadow",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={cn(
                "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                statusCfg.className,
              )}
            >
              {statusCfg.label}
            </span>
            {taskCount !== undefined && (
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {taskCount} task{taskCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <h3 className="font-semibold text-gray-900 dark:text-white text-sm truncate">{sprint.name}</h3>
          {sprint.goal && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 flex items-start gap-1 line-clamp-2">
              <Target className="w-3 h-3 mt-0.5 flex-shrink-0" />
              {sprint.goal}
            </p>
          )}
          {(sprint.start_date || sprint.end_date) && (
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1">
              <Calendar className="w-3 h-3 flex-shrink-0" />
              {formatDate(sprint.start_date)} – {formatDate(sprint.end_date)}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 px-2"
          onClick={() => onDelete(sprint.id)}
          aria-label={`Delete sprint ${sprint.name}`}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
