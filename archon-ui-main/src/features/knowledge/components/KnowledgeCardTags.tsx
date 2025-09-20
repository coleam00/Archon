/**
 * Knowledge Card Tags Component
 * Displays and allows inline editing of tags for knowledge items
 */

import { ChevronDown, ChevronUp, Plus, Tag, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../../../components/ui/Badge";
import { Input } from "../../ui/primitives";
import { cn } from "../../ui/primitives/styles";
import { SimpleTooltip } from "../../ui/primitives/tooltip";
import { useUpdateKnowledgeItem } from "../hooks";

interface KnowledgeCardTagsProps {
  sourceId: string;
  tags: string[];
}

export const KnowledgeCardTags: React.FC<KnowledgeCardTagsProps> = ({ sourceId, tags }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editingTags, setEditingTags] = useState<string[]>(tags);
  const [newTagValue, setNewTagValue] = useState("");
  const [originalTagBeingEdited, setOriginalTagBeingEdited] = useState<string | null>(null);
  const [showAllTags, setShowAllTags] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const updateMutation = useUpdateKnowledgeItem();

  // Determine how many tags to show (2 rows worth, approximately 6-8 tags depending on length)
  const MAX_TAGS_COLLAPSED = 6;

  // Update local state when props change, but only when not editing to avoid overwriting user input
  useEffect(() => {
    if (!isEditing) {
      setEditingTags(tags);
    }
  }, [tags, isEditing]);

  // Focus input when starting to add a new tag
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const handleSaveTags = async () => {
    const updatedTags = editingTags.filter((tag) => tag.trim().length > 0);

    try {
      await updateMutation.mutateAsync({
        sourceId,
        updates: {
          tags: updatedTags,
        },
      });
      setIsEditing(false);
      setNewTagValue("");
    } catch (_error) {
      // Reset on error
      setEditingTags(tags);
      setNewTagValue("");
    }
  };

  const handleCancelEdit = () => {
    setEditingTags(tags);
    setNewTagValue("");
    setOriginalTagBeingEdited(null);
    setIsEditing(false);
  };

  const handleAddTagAndSave = async () => {
    const trimmed = newTagValue.trim();
    if (trimmed) {
      let newTags = [...editingTags];

      // If we're editing an existing tag, remove the original first
      if (originalTagBeingEdited) {
        newTags = newTags.filter((tag) => tag !== originalTagBeingEdited);
      }

      // Add the new/modified tag if it doesn't already exist
      if (!newTags.includes(trimmed)) {
        newTags.push(trimmed);
      }

      // Save directly without updating local state first
      const updatedTags = newTags.filter((tag) => tag.trim().length > 0);

      try {
        await updateMutation.mutateAsync({
          sourceId,
          updates: {
            tags: updatedTags,
          },
        });
        setIsEditing(false);
        setNewTagValue("");
        setOriginalTagBeingEdited(null);
      } catch (_error) {
        // Reset on error
        setEditingTags(tags);
        setNewTagValue("");
        setOriginalTagBeingEdited(null);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (newTagValue.trim()) {
        // Add tag and save immediately
        handleAddTagAndSave();
      } else {
        // If no tag in input, just save current state
        handleSaveTags();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const handleAddTag = () => {
    const trimmed = newTagValue.trim();
    if (trimmed) {
      let newTags = [...editingTags];

      // If we're editing an existing tag, remove the original first
      if (originalTagBeingEdited) {
        newTags = newTags.filter((tag) => tag !== originalTagBeingEdited);
      }

      // Add the new/modified tag if it doesn't already exist
      if (!newTags.includes(trimmed)) {
        newTags.push(trimmed);
      }

      setEditingTags(newTags);
      setNewTagValue("");
      setOriginalTagBeingEdited(null);
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setEditingTags(editingTags.filter((tag) => tag !== tagToRemove));
  };

  const handleDeleteTag = async (tagToDelete: string) => {
    // Remove the tag and save immediately
    const updatedTags = tags.filter((tag) => tag !== tagToDelete);

    try {
      await updateMutation.mutateAsync({
        sourceId,
        updates: {
          tags: updatedTags,
        },
      });
    } catch (_error) {
      // Error handling is done by the mutation hook
    }
  };

  const handleEditTag = (tagToEdit: string) => {
    // When clicking an existing tag in edit mode, put it in the input for editing
    if (isEditing) {
      setNewTagValue(tagToEdit);
      setOriginalTagBeingEdited(tagToEdit);
      // Focus the input
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select(); // Select all text for easy editing
        }
      }, 0);
    }
  };

  const displayTags = isEditing ? editingTags : tags;
  const visibleTags = showAllTags || isEditing ? displayTags : displayTags.slice(0, MAX_TAGS_COLLAPSED);
  const hasMoreTags = displayTags.length > MAX_TAGS_COLLAPSED;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* Display tags */}
      {visibleTags.map((tag) => (
        <div key={tag} className="relative">
          {isEditing ? (
            <SimpleTooltip content={`Click to edit "${tag}"`}>
              <Badge
                color="gray"
                variant="outline"
                className="flex items-center gap-1 text-[10px] cursor-pointer group pr-0.5 px-1.5 py-0.5 h-5"
                onClick={() => handleEditTag(tag)}
              >
                <Tag className="w-2.5 h-2.5" />
                <span>{tag}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation(); // Prevent triggering the edit when clicking remove
                    handleRemoveTag(tag);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 hover:text-red-500"
                  aria-label={`Remove ${tag} tag`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </Badge>
            </SimpleTooltip>
          ) : (
            <div className="relative group">
              <SimpleTooltip content={`Click to edit "${tag}"`}>
                <Badge
                  color="gray"
                  variant="outline"
                  className="flex items-center gap-1 text-[10px] cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors group pr-0.5 px-1.5 py-0.5 h-5"
                  onClick={() => {
                    setIsEditing(true);
                    // Load this specific tag for editing
                    setNewTagValue(tag);
                    setOriginalTagBeingEdited(tag);
                    setTimeout(() => {
                      if (inputRef.current) {
                        inputRef.current.focus();
                        inputRef.current.select();
                      }
                    }, 0);
                  }}
                >
                  <Tag className="w-2.5 h-2.5" />
                  <span>{tag}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent triggering the edit when clicking delete
                      handleDeleteTag(tag);
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 hover:text-red-500"
                    aria-label={`Delete ${tag} tag`}
                    disabled={updateMutation.isPending}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </Badge>
              </SimpleTooltip>
            </div>
          )}
        </div>
      ))}

      {/* Show more/less button */}
      {!isEditing && hasMoreTags && (
        <button
          type="button"
          onClick={() => setShowAllTags(!showAllTags)}
          className="flex items-center gap-0.5 text-[10px] text-gray-500 dark:text-gray-400 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors px-1 py-0.5 rounded"
        >
          {showAllTags ? (
            <>
              <span>Show less</span>
              <ChevronUp className="w-2.5 h-2.5" />
            </>
          ) : (
            <>
              <span>+{displayTags.length - MAX_TAGS_COLLAPSED} more</span>
              <ChevronDown className="w-2.5 h-2.5" />
            </>
          )}
        </button>
      )}

      {/* Add tag input */}
      {isEditing && (
        <div className="flex items-center gap-1">
          <Input
            ref={inputRef}
            value={newTagValue}
            onChange={(e) => setNewTagValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (newTagValue.trim()) {
                handleAddTag();
              }
            }}
            placeholder={originalTagBeingEdited ? "Edit tag..." : "Add tag..."}
            className={cn(
              "h-6 text-xs px-2 w-20 min-w-0",
              "border-cyan-400 dark:border-cyan-600",
              "focus:ring-1 focus:ring-cyan-400",
            )}
            disabled={updateMutation.isPending}
          />
          <button
            type="button"
            onClick={() => {
              if (newTagValue.trim()) {
                handleAddTag();
              }
            }}
            className="text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300"
            disabled={!newTagValue.trim() || updateMutation.isPending}
            aria-label="Add tag"
          >
            <Plus className="w-2.5 h-2.5" />
          </button>
        </div>
      )}

      {/* Add tag button when not editing */}
      {!isEditing && (
        <SimpleTooltip content="Click to add or edit tags">
          <button
            type="button"
            onClick={() => {
              setIsEditing(true);
              setOriginalTagBeingEdited(null); // Clear any existing edit state
              setTimeout(() => {
                if (inputRef.current) {
                  inputRef.current.focus();
                }
              }, 0);
            }}
            className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:text-cyan-600 dark:hover:text-cyan-400 hover:border-cyan-400 dark:hover:border-cyan-600 transition-colors h-5"
            aria-label="Add tags"
          >
            <Plus className="w-2.5 h-2.5" />
            <span>Tags</span>
          </button>
        </SimpleTooltip>
      )}

      {/* Save/Cancel buttons when editing */}
      {isEditing && (
        <div className="flex items-center gap-1 ml-2">
          <button
            type="button"
            onClick={handleSaveTags}
            disabled={updateMutation.isPending}
            className="px-2 py-1 text-xs bg-cyan-600 text-white rounded hover:bg-cyan-700 disabled:opacity-50 transition-colors"
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleCancelEdit}
            disabled={updateMutation.isPending}
            className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};
