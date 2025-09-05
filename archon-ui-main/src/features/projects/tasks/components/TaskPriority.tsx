/**
 * TaskPriority Component
 *
 * Display-only priority selector for tasks.
 * NOTE: Priority is currently frontend-only and doesn't affect task ordering.
 * Task ordering is handled separately via drag-and-drop with task_order field.
 * This is purely for visual categorization until backend priority support is added.
 */

import { AlertCircle } from "lucide-react";
import type React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../../../ui/primitives/select";
import { cn, glassmorphism } from "../../../ui/primitives/styles";

export type Priority = "critical" | "high" | "medium" | "low";

interface TaskPriorityProps {
  priority?: Priority;
  onPriorityChange?: (priority: Priority) => void;
  isLoading?: boolean;
}

// Priority options for the dropdown
const PRIORITY_OPTIONS: Array<{
  value: Priority;
  label: string;
  color: string;
}> = [
  { value: "critical", label: "Critical", color: "text-red-600" },
  { value: "high", label: "High", color: "text-orange-600" },
  { value: "medium", label: "Medium", color: "text-blue-600" },
  { value: "low", label: "Low", color: "text-gray-600" },
];

export const TaskPriority: React.FC<TaskPriorityProps> = ({
  priority = "medium",
  onPriorityChange,
  isLoading = false,
}) => {
  // Get priority-specific styling with Tron glow
  const getPriorityStyles = (priorityValue: Priority) => {
    switch (priorityValue) {
      case "critical":
        return {
          background: glassmorphism.priority.critical.background,
          text: glassmorphism.priority.critical.text,
          hover: glassmorphism.priority.critical.hover,
          glow: glassmorphism.priority.critical.glow,
          iconColor: "text-red-500",
        };
      case "high":
        return {
          background: glassmorphism.priority.high.background,
          text: glassmorphism.priority.high.text,
          hover: glassmorphism.priority.high.hover,
          glow: glassmorphism.priority.high.glow,
          iconColor: "text-orange-500",
        };
      case "medium":
        return {
          background: glassmorphism.priority.medium.background,
          text: glassmorphism.priority.medium.text,
          hover: glassmorphism.priority.medium.hover,
          glow: glassmorphism.priority.medium.glow,
          iconColor: "text-blue-500",
        };
      default:
        return {
          background: glassmorphism.priority.low.background,
          text: glassmorphism.priority.low.text,
          hover: glassmorphism.priority.low.hover,
          glow: glassmorphism.priority.low.glow,
          iconColor: "text-gray-500",
        };
    }
  };

  const currentStyles = getPriorityStyles(priority);
  const currentOption = PRIORITY_OPTIONS.find((opt) => opt.value === priority) || PRIORITY_OPTIONS[2]; // Default to medium

  // If no change handler, just show a static button
  if (!onPriorityChange) {
    return (
      <button
        type="button"
        disabled
        className={cn(
          "flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium",
          "transition-all duration-300",
          currentStyles.background,
          currentStyles.text,
          "opacity-75 cursor-not-allowed",
        )}
        title={`Priority: ${currentOption.label}`}
        aria-label={`Priority: ${currentOption.label}`}
      >
        <AlertCircle className={cn("w-3 h-3", currentStyles.iconColor)} aria-hidden="true" />
        <span>{currentOption.label}</span>
      </button>
    );
  }

  return (
    <Select value={priority} onValueChange={(value) => onPriorityChange(value as Priority)}>
      <SelectTrigger
        disabled={isLoading}
        className={cn(
          "h-auto px-2 py-1 rounded-full text-xs font-medium min-w-[80px]",
          "border-0 shadow-none", // Remove default border and shadow
          "transition-all duration-300",
          currentStyles.background,
          currentStyles.text,
          currentStyles.hover,
          currentStyles.glow,
          "backdrop-blur-md",
        )}
        showChevron={false}
        aria-label={`Priority: ${currentOption.label}${isLoading ? " (updating...)" : ""}`}
        aria-disabled={isLoading}
      >
        <div className="flex items-center gap-1">
          <AlertCircle className={cn("w-3 h-3", currentStyles.iconColor)} />
          <span>{currentOption.label}</span>
        </div>
      </SelectTrigger>

      <SelectContent className="min-w-[120px]">
        {PRIORITY_OPTIONS.map((option) => {
          const optionStyles = getPriorityStyles(option.value);

          return (
            <SelectItem key={option.value} value={option.value} className={option.color}>
              <div className="flex items-center gap-1">
                <AlertCircle className={cn("w-3 h-3", optionStyles.iconColor)} />
                <span>{option.label}</span>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
};
