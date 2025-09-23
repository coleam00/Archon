/**
 * Knowledge Card Type Component
 * Displays and allows inline editing of knowledge item type (technical/business)
 */

import { Briefcase, Terminal } from "lucide-react";
import { useState } from "react";
import { useAutoSave } from "../../shared/hooks/useAutoSave";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/primitives";
import { cn } from "../../ui/primitives/styles";
import { SimpleTooltip } from "../../ui/primitives/tooltip";
import { useUpdateKnowledgeItem } from "../hooks";

interface KnowledgeCardTypeProps {
  sourceId: string;
  knowledgeType: "technical" | "business";
}

export const KnowledgeCardType: React.FC<KnowledgeCardTypeProps> = ({ sourceId, knowledgeType }) => {
  const [isEditing, setIsEditing] = useState(false);
  const updateMutation = useUpdateKnowledgeItem();

  // Use auto-save hook for immediate type changes
  const { isSaving, hasError, save } = useAutoSave<"technical" | "business">({
    value: knowledgeType,
    onSave: async (newType) => {
      await updateMutation.mutateAsync({
        sourceId,
        updates: { knowledge_type: newType },
      });
    },
    isEditing: false, // Type changes are immediate
    debounceMs: 0,
  });

  const isTechnical = knowledgeType === "technical";

  const handleTypeChange = async (newType: "technical" | "business") => {
    if (newType === knowledgeType) {
      setIsEditing(false);
      return;
    }

    try {
      // Use the hook's save function instead of calling mutation directly
      await save(newType);
    } finally {
      // Always exit editing mode regardless of success or failure
      // The hook's onSave handler will show error toasts if needed
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
      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Select
          open={isEditing}
          onOpenChange={(open) => setIsEditing(open)}
          value={knowledgeType}
          onValueChange={(value) => handleTypeChange(value as "technical" | "business")}
          disabled={updateMutation.isPending || isSaving}
        >
          <SelectTrigger
            className={cn(
              "w-auto h-auto text-xs font-medium px-2 py-1 rounded-md",
              "border-cyan-400 dark:border-cyan-600",
              "focus:ring-1 focus:ring-cyan-400",
              hasError && "border-red-400 dark:border-red-600",
              isTechnical
                ? "bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400"
                : "bg-pink-100 text-pink-700 dark:bg-pink-500/10 dark:text-pink-400",
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
    <SimpleTooltip
      content={`${isTechnical ? "Technical documentation" : "Business/general content"} - Click to change`}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium cursor-pointer",
          "hover:ring-1 hover:ring-cyan-400/50 transition-all",
          hasError && "ring-1 ring-red-400/50",
          isTechnical
            ? "bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400"
            : "bg-pink-100 text-pink-700 dark:bg-pink-500/10 dark:text-pink-400",
          (updateMutation.isPending || isSaving) && "opacity-50 cursor-not-allowed",
        )}
        onClick={handleClick}
      >
        {getTypeIcon()}
        <span>{getTypeLabel()}</span>
      </div>
    </SimpleTooltip>
  );
};
