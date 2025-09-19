/**
 * Knowledge Card Title Component
 * Displays and allows inline editing of knowledge item titles
 */

import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "../../ui/primitives";
import { cn } from "../../ui/primitives/styles";
import { SimpleTooltip, Tooltip, TooltipContent, TooltipTrigger } from "../../ui/primitives/tooltip";
import { useUpdateKnowledgeItem } from "../hooks";

// Centralized color class mappings
const ICON_COLOR_CLASSES: Record<string, string> = {
  cyan: "text-gray-400 hover:!text-cyan-600 dark:text-gray-500 dark:hover:!text-cyan-400",
  purple: "text-gray-400 hover:!text-purple-600 dark:text-gray-500 dark:hover:!text-purple-400",
  blue: "text-gray-400 hover:!text-blue-600 dark:text-gray-500 dark:hover:!text-blue-400",
  pink: "text-gray-400 hover:!text-pink-600 dark:text-gray-500 dark:hover:!text-pink-400",
  red: "text-gray-400 hover:!text-red-600 dark:text-gray-500 dark:hover:!text-red-400",
  yellow: "text-gray-400 hover:!text-yellow-600 dark:text-gray-500 dark:hover:!text-yellow-400",
  default: "text-gray-400 hover:!text-blue-600 dark:text-gray-500 dark:hover:!text-blue-400",
};

const TOOLTIP_COLOR_CLASSES: Record<string, string> = {
  cyan: "border-cyan-500/50 shadow-[0_0_15px_rgba(34,211,238,0.5)] dark:border-cyan-400/50 dark:shadow-[0_0_15px_rgba(34,211,238,0.7)]",
  purple:
    "border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.5)] dark:border-purple-400/50 dark:shadow-[0_0_15px_rgba(168,85,247,0.7)]",
  blue: "border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.5)] dark:border-blue-400/50 dark:shadow-[0_0_15px_rgba(59,130,246,0.7)]",
  pink: "border-pink-500/50 shadow-[0_0_15px_rgba(236,72,153,0.5)] dark:border-pink-400/50 dark:shadow-[0_0_15px_rgba(236,72,153,0.7)]",
  red: "border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.5)] dark:border-red-400/50 dark:shadow-[0_0_15px_rgba(239,68,68,0.7)]",
  yellow:
    "border-yellow-500/50 shadow-[0_0_15px_rgba(234,179,8,0.5)] dark:border-yellow-400/50 dark:shadow-[0_0_15px_rgba(234,179,8,0.7)]",
  default:
    "border-cyan-500/50 shadow-[0_0_15px_rgba(34,211,238,0.5)] dark:border-cyan-400/50 dark:shadow-[0_0_15px_rgba(34,211,238,0.7)]",
};

interface KnowledgeCardTitleProps {
  sourceId: string;
  title: string;
  description?: string;
  accentColor: "cyan" | "purple" | "blue" | "pink" | "red" | "yellow";
}

export const KnowledgeCardTitle: React.FC<KnowledgeCardTitleProps> = ({
  sourceId,
  title,
  description,
  accentColor,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const updateMutation = useUpdateKnowledgeItem();

  // Simple lookups using centralized color mappings
  const getIconColorClass = () => ICON_COLOR_CLASSES[accentColor] ?? ICON_COLOR_CLASSES.default;
  const getTooltipColorClass = () => TOOLTIP_COLOR_CLASSES[accentColor] ?? TOOLTIP_COLOR_CLASSES.default;

  // Update local state when props change, but only when not editing to avoid overwriting user input
  useEffect(() => {
    if (!isEditing) {
      setEditValue(title);
    }
  }, [title, isEditing]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = async () => {
    const trimmedValue = editValue.trim();
    if (trimmedValue === title) {
      setIsEditing(false);
      return;
    }

    if (!trimmedValue) {
      // Don't allow empty titles, revert to original
      setEditValue(title);
      setIsEditing(false);
      return;
    }

    try {
      await updateMutation.mutateAsync({
        sourceId,
        updates: {
          title: trimmedValue,
        },
      });
      setIsEditing(false);
    } catch (_error) {
      // Reset on error
      setEditValue(title);
      setIsEditing(false);
    }
  };

  const handleCancel = () => {
    setEditValue(title);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Stop all key events from bubbling to prevent card interactions
    e.stopPropagation();

    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
    // For all other keys (including space), let them work normally in the input
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click
    if (!isEditing && !updateMutation.isPending) {
      setIsEditing(true);
    }
  };

  if (isEditing) {
    return (
      <div
        className="flex items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
          onInput={(e) => e.stopPropagation()}
          onFocus={(e) => e.stopPropagation()}
          disabled={updateMutation.isPending}
          className={cn(
            "text-base font-semibold bg-transparent border-cyan-400 dark:border-cyan-600",
            "focus:ring-1 focus:ring-cyan-400 px-2 py-1",
          )}
        />
        {description && description.trim() && (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <Info
                className={cn(
                  "w-3.5 h-3.5 transition-colors flex-shrink-0 opacity-70 hover:opacity-100 cursor-help",
                  getIconColorClass(),
                )}
              />
            </TooltipTrigger>
            <TooltipContent side="top" className={cn("max-w-xs whitespace-pre-wrap", getTooltipColorClass())}>
              {description}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <SimpleTooltip content="Click to edit title">
        <h3
          className={cn(
            "text-base font-semibold text-gray-900 dark:text-white/90 line-clamp-2 cursor-pointer",
            "hover:text-gray-700 dark:hover:text-white transition-colors",
            updateMutation.isPending && "opacity-50",
          )}
          onClick={handleClick}
        >
          {title}
        </h3>
      </SimpleTooltip>
      {description && description.trim() && (
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <Info
              className={cn(
                "w-3.5 h-3.5 transition-colors flex-shrink-0 opacity-70 hover:opacity-100 cursor-help",
                getIconColorClass(),
              )}
            />
          </TooltipTrigger>
          <TooltipContent side="top" className={cn("max-w-xs whitespace-pre-wrap", getTooltipColorClass())}>
            {description}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
