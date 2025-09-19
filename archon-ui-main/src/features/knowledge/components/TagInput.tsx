/**
 * Tag Input Component
 * Visual tag management with add/remove functionality
 */

import { motion } from "framer-motion";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Input } from "../../ui/primitives";
import { cn } from "../../ui/primitives/styles";

interface TagInputProps {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  maxTags?: number;
}

export const TagInput: React.FC<TagInputProps> = ({
  tags,
  onTagsChange,
  placeholder = "Enter a tag and press Enter",
  disabled = false,
  maxTags = 10,
}) => {
  const [inputValue, setInputValue] = useState("");

  const addTag = (tag: string) => {
    const trimmedTag = tag.trim();
    if (trimmedTag && !tags.includes(trimmedTag) && tags.length < maxTags) {
      onTagsChange([...tags, trimmedTag]);
      setInputValue("");
    }
  };

  const removeTag = (tagToRemove: string) => {
    onTagsChange(tags.filter((tag) => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === "Backspace" && !inputValue && tags.length > 0) {
      // Remove last tag when backspace is pressed on empty input
      removeTag(tags[tags.length - 1]);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Handle comma-separated input for backwards compatibility
    if (value.includes(",")) {
      // Collect pasted candidates, trim and filter them
      const newCandidates = value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);

      // Merge with current tags using Set to dedupe
      const combinedTags = new Set([...tags, ...newCandidates]);
      const combinedArray = Array.from(combinedTags);

      // Enforce maxTags limit by taking only the first N allowed tags
      const finalTags = combinedArray.slice(0, maxTags);

      // Single batched update
      onTagsChange(finalTags);
      setInputValue("");
    } else {
      setInputValue(value);
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-gray-900 dark:text-white/90">Tags</div>

      {/* Tag Display */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag, index) => (
            <motion.div
              key={tag}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium",
                "backdrop-blur-md bg-gradient-to-r from-blue-100/80 to-blue-50/60 dark:from-blue-900/40 dark:to-blue-800/30",
                "border border-blue-300/50 dark:border-blue-700/50",
                "text-blue-700 dark:text-blue-300",
                "transition-all duration-200",
              )}
            >
              <span className="max-w-24 truncate">{tag}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="ml-0.5 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200 transition-colors"
                  aria-label={`Remove ${tag} tag`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </motion.div>
          ))}
        </div>
      )}

      {/* Tag Input */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <Plus className="h-4 w-4 text-gray-400 dark:text-gray-500" />
        </div>
        <Input
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={tags.length >= maxTags ? "Maximum tags reached" : placeholder}
          disabled={disabled || tags.length >= maxTags}
          className="pl-9 backdrop-blur-md bg-gradient-to-r from-white/60 to-white/50 dark:from-black/60 dark:to-black/50 border-gray-300/60 dark:border-gray-600/60 focus:border-blue-400/70 focus:shadow-[0_0_15px_rgba(59,130,246,0.15)]"
        />
      </div>

      {/* Help Text */}
      <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
        <p>Press Enter or comma to add tags • Backspace to remove last tag</p>
        {maxTags && (
          <p>
            {tags.length}/{maxTags} tags used
          </p>
        )}
      </div>
    </div>
  );
};
