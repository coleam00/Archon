import { Bot, User } from "lucide-react";
import type React from "react";
import { ComboBox, type ComboBoxOption } from "../../../ui/primitives/combobox";
import { cn } from "../../../ui/primitives/styles";
import { type Assignee, COMMON_ASSIGNEES } from "../types";

interface TaskAssigneeProps {
  assignee: Assignee;
  onAssigneeChange?: (newAssignee: Assignee) => void;
  isLoading?: boolean;
}

// Convert common assignees to ComboBox options
const ASSIGNEE_OPTIONS: ComboBoxOption[] = COMMON_ASSIGNEES.map((name) => ({
  value: name,
  label: name,
}));

// Truncate long assignee names for display
const truncateAssignee = (assignee: string, maxLength = 20) => {
  if (assignee.length <= maxLength) return assignee;
  return `${assignee.slice(0, maxLength - 3)}...`;
};

// Get icon for assignee (with fallback for custom agents)
const getAssigneeIcon = (assigneeName: string, size: "sm" | "md" = "sm") => {
  const sizeClass = size === "sm" ? "w-3 h-3" : "w-4 h-4";

  // Known assignees get specific icons
  if (assigneeName === "User") {
    return <User className={cn(sizeClass, "text-blue-400")} />;
  }
  if (assigneeName === "Archon") {
    return <img src="/logo-neon.png" alt="Archon" className={sizeClass} />;
  }
  if (
    assigneeName === "Coding Agent" ||
    assigneeName.toLowerCase().includes("agent") ||
    assigneeName.toLowerCase().includes("ai")
  ) {
    return <Bot className={cn(sizeClass, "text-purple-400")} />;
  }

  // Unknown agents get a bot icon with first letter overlay
  return (
    <div className="relative flex items-center justify-center">
      <Bot className={cn(sizeClass, "text-gray-400 opacity-60")} />
      <span className="absolute text-[8px] font-bold text-white/90">{assigneeName[0]?.toUpperCase() || "?"}</span>
    </div>
  );
};

// Get glow effect styles based on assignee type
const getAssigneeStyles = (assigneeName: string) => {
  // Known assignees get specific colors
  if (assigneeName === "User") {
    return {
      glow: "shadow-[0_0_10px_rgba(59,130,246,0.4)]",
      hoverGlow: "hover:shadow-[0_0_12px_rgba(59,130,246,0.5)]",
      color: "text-blue-600 dark:text-blue-400",
    };
  }
  if (assigneeName === "Archon") {
    return {
      glow: "shadow-[0_0_10px_rgba(34,211,238,0.4)]",
      hoverGlow: "hover:shadow-[0_0_12px_rgba(34,211,238,0.5)]",
      color: "text-cyan-600 dark:text-cyan-400",
    };
  }
  if (
    assigneeName === "Coding Agent" ||
    assigneeName.toLowerCase().includes("agent") ||
    assigneeName.toLowerCase().includes("ai")
  ) {
    return {
      glow: "shadow-[0_0_10px_rgba(168,85,247,0.4)]",
      hoverGlow: "hover:shadow-[0_0_12px_rgba(168,85,247,0.5)]",
      color: "text-purple-600 dark:text-purple-400",
    };
  }

  // Custom agents get a neutral glow
  return {
    glow: "shadow-[0_0_10px_rgba(156,163,175,0.3)]",
    hoverGlow: "hover:shadow-[0_0_12px_rgba(156,163,175,0.4)]",
    color: "text-gray-600 dark:text-gray-400",
  };
};

export const TaskAssignee: React.FC<TaskAssigneeProps> = ({ assignee, onAssigneeChange, isLoading }) => {
  const styles = getAssigneeStyles(assignee);

  // If no change handler, just show a static display
  if (!onAssigneeChange) {
    return (
      <div className="flex items-center gap-2" title={assignee}>
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
        <span className={cn("text-xs truncate max-w-[150px]", "text-gray-600 dark:text-gray-400")}>
          {truncateAssignee(assignee, 25)}
        </span>
      </div>
    );
  }

  // For editable mode, use a streamlined ComboBox
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Stop propagation for all keys to prevent TaskCard from handling them
        e.stopPropagation();
      }}
    >
      <ComboBox
        options={ASSIGNEE_OPTIONS}
        value={assignee}
        onValueChange={onAssigneeChange}
        placeholder="Assignee"
        searchPlaceholder="Assign to..."
        emptyMessage="Press Enter to add"
        className="min-w-[90px] max-w-[140px]"
        allowCustomValue={true}
        disabled={isLoading}
      />
    </div>
  );
};
