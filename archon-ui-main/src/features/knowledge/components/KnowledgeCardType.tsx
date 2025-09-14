/**
 * Knowledge Card Type Component
 * Displays and allows inline editing of knowledge item type (technical/business)
 */

import { Briefcase, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/primitives";
import { cn } from "../../ui/primitives/styles";
import { SimpleTooltip } from "../../ui/primitives/tooltip";
import { useToast } from "../../ui/hooks/useToast";
import { useUpdateKnowledgeItem } from "../hooks";

interface KnowledgeCardTypeProps {
  sourceId: string;
  knowledgeType: "technical" | "business";
}

export const KnowledgeCardType: React.FC<KnowledgeCardTypeProps> = ({
  sourceId,
  knowledgeType,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const selectRef = useRef<HTMLDivElement>(null);
  const updateMutation = useUpdateKnowledgeItem();
  const { showToast } = useToast();

  // Handle click outside to cancel editing
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (isEditing && selectRef.current && event.target) {
        const target = event.target as Element;

        // Don't close if clicking on the select component or its dropdown content
        if (!selectRef.current.contains(target) &&
            !target.closest('[data-radix-select-content]') &&
            !target.closest('[data-radix-select-item]') &&
            !target.closest('[data-radix-popper-content-wrapper]')) {
          setIsEditing(false);
        }
      }
    };

    if (isEditing) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isEditing]);

  const isTechnical = knowledgeType === "technical";

  const handleTypeChange = async (newType: "technical" | "business") => {
    if (newType === knowledgeType) {
      setIsEditing(false);
      return;
    }

    try {
      await updateMutation.mutateAsync({
        sourceId,
        updates: {
          knowledge_type: newType,
        },
      });
      setIsEditing(false);
    } catch (error) {
      // Show user-facing error toast with detailed message
      const errorMessage = error instanceof Error ? error.message : "Update failed";
      showToast(`Failed to update knowledge type: ${errorMessage}`, "error");
      setIsEditing(false);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click
    if (!isEditing && !updateMutation.isPending) {
      setIsEditing(true);
    }
  };

  const getTypeLabel = () => {
    return isTechnical ? "Technical" : "Business";
  };

  const getTypeIcon = () => {
    return isTechnical ? <Terminal className="w-3.5 h-3.5" /> : <Briefcase className="w-3.5 h-3.5" />;
  };

  if (isEditing) {
    return (
      <div
        ref={selectRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Select
          value={knowledgeType}
          onValueChange={(value) => handleTypeChange(value as "technical" | "business")}
          disabled={updateMutation.isPending}
        >
          <SelectTrigger
            className={cn(
              "w-auto h-auto text-xs font-medium px-2 py-1 rounded-md",
              "border-cyan-400 dark:border-cyan-600",
              "focus:ring-1 focus:ring-cyan-400",
              isTechnical
                ? "bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400"
                : "bg-pink-100 text-pink-700 dark:bg-pink-500/10 dark:text-pink-400"
            )}
          >
            <SelectValue>
              <div className="flex items-center gap-1.5">
                {getTypeIcon()}
                <span>{getTypeLabel()}</span>
              </div>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="technical">
              <div className="flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5" />
                <span>Technical</span>
              </div>
            </SelectItem>
            <SelectItem value="business">
              <div className="flex items-center gap-1.5">
                <Briefcase className="w-3.5 h-3.5" />
                <span>Business</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <SimpleTooltip content={`${isTechnical ? "Technical documentation" : "Business/general content"} - Click to change`}>
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium cursor-pointer",
          "hover:ring-1 hover:ring-cyan-400/50 transition-all",
          isTechnical
            ? "bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400"
            : "bg-pink-100 text-pink-700 dark:bg-pink-500/10 dark:text-pink-400",
          updateMutation.isPending && "opacity-50 cursor-not-allowed"
        )}
        onClick={handleClick}
      >
        {getTypeIcon()}
        <span>{getTypeLabel()}</span>
      </div>
    </SimpleTooltip>
  );
};