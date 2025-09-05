import { Bot, User } from "lucide-react";
import type React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../../../ui/primitives";
import { cn } from "../../../ui/primitives/styles";
import type { Assignee } from "../types";

interface TaskAssigneeProps {
  assignee: Assignee;
  onAssigneeChange?: (newAssignee: Assignee) => void;
  isLoading?: boolean;
}

const ASSIGNEE_OPTIONS: Assignee[] = ["User", "Archon", "AI IDE Agent"];

// Get icon for each assignee type
const getAssigneeIcon = (assigneeName: Assignee, size: "sm" | "md" = "sm") => {
  const sizeClass = size === "sm" ? "w-3 h-3" : "w-4 h-4";

  switch (assigneeName) {
    case "User":
      return <User className={cn(sizeClass, "text-blue-400")} />;
    case "AI IDE Agent":
      return <Bot className={cn(sizeClass, "text-purple-400")} />;
    case "Archon":
      return <img src="/logo-neon.png" alt="Archon" className={sizeClass} />;
    default:
      return <User className={cn(sizeClass, "text-blue-400")} />;
  }
};

// Get glow effect for each assignee type
const getAssigneeStyles = (assigneeName: Assignee) => {
  switch (assigneeName) {
    case "User":
      return {
        glow: "shadow-[0_0_10px_rgba(59,130,246,0.4)]",
        hoverGlow: "hover:shadow-[0_0_12px_rgba(59,130,246,0.5)]",
        color: "text-blue-600 dark:text-blue-400",
      };
    case "AI IDE Agent":
      return {
        glow: "shadow-[0_0_10px_rgba(168,85,247,0.4)]",
        hoverGlow: "hover:shadow-[0_0_12px_rgba(168,85,247,0.5)]",
        color: "text-purple-600 dark:text-purple-400",
      };
    case "Archon":
      return {
        glow: "shadow-[0_0_10px_rgba(34,211,238,0.4)]",
        hoverGlow: "hover:shadow-[0_0_12px_rgba(34,211,238,0.5)]",
        color: "text-cyan-600 dark:text-cyan-400",
      };
    default:
      return {
        glow: "shadow-[0_0_10px_rgba(59,130,246,0.4)]",
        hoverGlow: "hover:shadow-[0_0_12px_rgba(59,130,246,0.5)]",
        color: "text-blue-600 dark:text-blue-400",
      };
  }
};

export const TaskAssignee: React.FC<TaskAssigneeProps> = ({ assignee, onAssigneeChange, isLoading = false }) => {
  const styles = getAssigneeStyles(assignee);

  // If no change handler, just show a static display
  if (!onAssigneeChange) {
    return (
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex items-center justify-center w-5 h-5 rounded-full",
            "bg-white/80 dark:bg-black/70",
            "border border-gray-300/50 dark:border-gray-700/50",
            "backdrop-blur-md",
            styles.glow,
          )}
        >
          {getAssigneeIcon(assignee, "md")}
        </div>
        <span className="text-gray-600 dark:text-gray-400 text-xs">{assignee}</span>
      </div>
    );
  }

  return (
    <Select value={assignee} onValueChange={(value) => onAssigneeChange(value as Assignee)}>
      <SelectTrigger
        disabled={isLoading}
        className={cn(
          "h-auto py-0.5 px-1.5 gap-1.5",
          "border-0 shadow-none bg-transparent",
          "hover:bg-gray-100/50 dark:hover:bg-gray-900/50",
          "transition-all duration-200 rounded-md",
          "min-w-fit w-auto",
        )}
        showChevron={false}
        aria-label={`Assignee: ${assignee}${isLoading ? " (updating...)" : ""}`}
        aria-disabled={isLoading}
      >
        <div className="flex items-center gap-1.5">
          <div
            className={cn(
              "flex items-center justify-center w-5 h-5 rounded-full",
              "bg-white/80 dark:bg-black/70",
              "border border-gray-300/50 dark:border-gray-700/50",
              "backdrop-blur-md transition-shadow duration-200",
              styles.glow,
              styles.hoverGlow,
            )}
          >
            {getAssigneeIcon(assignee, "md")}
          </div>
          <span className={cn("text-xs", styles.color)}>{assignee}</span>
        </div>
      </SelectTrigger>

      <SelectContent className="min-w-[140px]">
        {ASSIGNEE_OPTIONS.map((option) => {
          const optionStyles = getAssigneeStyles(option);

          return (
            <SelectItem key={option} value={option}>
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "flex items-center justify-center w-5 h-5 rounded-full",
                    "bg-white/80 dark:bg-black/70",
                    "border border-gray-300/50 dark:border-gray-700/50",
                    optionStyles.glow,
                  )}
                >
                  {getAssigneeIcon(option, "md")}
                </div>
                <span className={cn("text-sm", optionStyles.color)}>{option}</span>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
};
