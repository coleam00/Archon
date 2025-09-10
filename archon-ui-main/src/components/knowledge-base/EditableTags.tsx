import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Input } from '../../features/ui/primitives/input';
import { cn } from '../../lib/utils';

// Validation constants
const MAX_TAG_LENGTH = 50;
const MAX_TAGS = 20;

interface EditableTagsProps {
  tags: string[];
  onTagsUpdate: (tags: string[]) => Promise<void>;
  maxVisibleTags?: number;
  className?: string;
  isUpdating?: boolean;
  onError?: (error: string) => void;
}

export const EditableTags: React.FC<EditableTagsProps> = ({
  tags = [],
  onTagsUpdate,
  maxVisibleTags = 4,
  className,
  isUpdating = false,
  onError,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [newTagValue, setNewTagValue] = useState('');
  const [localTags, setLocalTags] = useState(tags);
  const [isSaving, setIsSaving] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
  // Prevent concurrent save operations
  const saveInProgress = useRef(false);

  // Update local tags when props change
  useEffect(() => {
    setLocalTags(tags);
  }, [tags]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && editingIndex !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing, editingIndex]);

  // Focus add input when adding
  useEffect(() => {
    if (isEditing && editingIndex === null && addInputRef.current) {
      addInputRef.current.focus();
    }
  }, [isEditing, editingIndex]);

  const validateTag = (tag: string): { isValid: boolean; error?: string } => {
    const trimmedTag = tag.trim();
    
    if (!trimmedTag) {
      return { isValid: false, error: 'Tag cannot be empty' };
    }
    
    if (trimmedTag.length > MAX_TAG_LENGTH) {
      return { isValid: false, error: `Tag must be ${MAX_TAG_LENGTH} characters or less` };
    }
    
    if (localTags.includes(trimmedTag)) {
      return { isValid: false, error: 'Tag already exists' };
    }
    
    if (localTags.length >= MAX_TAGS) {
      return { isValid: false, error: `Maximum of ${MAX_TAGS} tags allowed` };
    }
    
    return { isValid: true };
  };

  const saveChanges = async (tagsToSave?: string[]) => {
    if (isSaving || saveInProgress.current) return;

    const finalTags = tagsToSave || localTags;
    saveInProgress.current = true;
    setIsSaving(true);
    setValidationError(null);
    
    try {
      await onTagsUpdate(finalTags);
      setIsEditing(false);
      setEditingIndex(null);
      setNewTagValue('');
    } catch (error) {
      const errorMessage = error instanceof Error 
        ? `Failed to save tags: ${error.message}` 
        : 'Failed to save tags: Unknown error occurred';
      
      console.error('Tag save error:', error);
      setValidationError(errorMessage);
      
      // Notify parent component of error
      if (onError) {
        onError(errorMessage);
      }
      
      // Reset local tags to last known good state
      setLocalTags(tags);
      throw error; // Re-throw to allow caller to handle
    } finally {
      setIsSaving(false);
      saveInProgress.current = false;
    }
  };

  const handleTagEdit = async (index: number, newValue: string) => {
    const trimmedValue = newValue.trim();
    setValidationError(null);
    
    if (!trimmedValue) {
      // Remove tag if empty
      const updatedTags = localTags.filter((_, i) => i !== index);
      setLocalTags(updatedTags);
      try {
        await saveChanges(updatedTags);
      } catch (error) {
        // Error already handled in saveChanges
      }
      return;
    }
    
    // Check if tag changed
    if (trimmedValue === localTags[index]) {
      setIsEditing(false);
      setEditingIndex(null);
      return;
    }
    
    // Validate against other tags (excluding current index)
    const otherTags = localTags.filter((_, i) => i !== index);
    
    if (otherTags.includes(trimmedValue)) {
      setValidationError('Tag already exists');
      return;
    }
    
    if (trimmedValue.length > MAX_TAG_LENGTH) {
      setValidationError(`Tag must be ${MAX_TAG_LENGTH} characters or less`);
      return;
    }
    
    const updatedTags = [...localTags];
    updatedTags[index] = trimmedValue;
    setLocalTags(updatedTags);
    
    try {
      await saveChanges(updatedTags);
    } catch (error) {
      // Error already handled in saveChanges
    }
  };

  const handleTagAdd = async () => {
    const trimmedValue = newTagValue.trim();
    setValidationError(null);
    
    const validation = validateTag(trimmedValue);
    
    if (!validation.isValid) {
      setValidationError(validation.error || 'Invalid tag');
      return;
    }
    
    const updatedTags = [...localTags, trimmedValue];
    setLocalTags(updatedTags);
    setNewTagValue('');
    
    try {
      await saveChanges(updatedTags);
    } catch (error) {
      // Error already handled in saveChanges
      setNewTagValue(trimmedValue); // Restore the value for user to see
    }
  };

  const handleTagRemove = async (index: number) => {
    const updatedTags = localTags.filter((_, i) => i !== index);
    setLocalTags(updatedTags);
    try {
      await saveChanges(updatedTags);
    } catch (error) {
      // Error already handled in saveChanges
    }
  };

  const handleCancel = () => {
    setLocalTags(tags);
    setIsEditing(false);
    setEditingIndex(null);
    setNewTagValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent, index?: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (index !== undefined) {
        handleTagEdit(index, (e.target as HTMLInputElement).value);
      } else {
        handleTagAdd();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    } else if (e.key === 'Tab' && index !== undefined) {
      // Allow natural tab behavior
      setEditingIndex(null);
    }
  };

  if (localTags.length === 0 && !isEditing) {
    return (
      <div className={cn('w-full', className)}>
        <button
          onClick={() => {
            setIsEditing(true);
            setEditingIndex(null);
          }}
          disabled={isUpdating || isSaving}
          className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add tags...
        </button>
      </div>
    );
  }

  const visibleTags = localTags.slice(0, maxVisibleTags);
  const remainingTags = localTags.slice(maxVisibleTags);
  const hasMoreTags = remainingTags.length > 0;

  return (
    <div className={cn('w-full', className)}>
      <div className="flex flex-wrap gap-2 h-full">
        {visibleTags.map((tag, index) => (
          <div key={index} className="relative">
            {isEditing && editingIndex === index ? (
              <Input
                ref={inputRef}
                defaultValue={tag}
                onBlur={(e) => handleTagEdit(index, e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                disabled={isSaving}
                className={cn(
                  'h-6 text-xs px-2 py-0 w-20 min-w-[60px]',
                  'border-cyan-400 dark:border-cyan-600',
                  'focus:ring-1 focus:ring-cyan-400',
                )}
              />
            ) : (
              <Badge
                color="purple"
                variant="outline"
                className={cn(
                  'text-xs cursor-pointer group relative pr-6',
                  !isUpdating && !isSaving && 'hover:bg-purple-50/50 dark:hover:bg-purple-900/20',
                  isUpdating || isSaving ? 'opacity-50 cursor-not-allowed' : ''
                )}
                onClick={() => {
                  if (!isUpdating && !isSaving) {
                    setIsEditing(true);
                    setEditingIndex(index);
                  }
                }}
              >
                {tag}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isUpdating && !isSaving) {
                      handleTagRemove(index);
                    }
                  }}
                  disabled={isUpdating || isSaving}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3 text-gray-400 hover:text-red-500" />
                </button>
              </Badge>
            )}
          </div>
        ))}

        {/* Add new tag input */}
        {isEditing && editingIndex === null && (
          <Input
            ref={addInputRef}
            value={newTagValue}
            onChange={(e) => setNewTagValue(e.target.value)}
            onBlur={handleTagAdd}
            onKeyDown={(e) => handleKeyDown(e)}
            placeholder="New tag"
            disabled={isSaving}
            className={cn(
              'h-6 text-xs px-2 py-0 w-20 min-w-[60px]',
              'border-cyan-400 dark:border-cyan-600',
              'focus:ring-1 focus:ring-cyan-400',
            )}
          />
        )}

        {/* Add button */}
        {!isEditing && (
          <button
            onClick={() => {
              setIsEditing(true);
              setEditingIndex(null);
            }}
            disabled={isUpdating || isSaving}
            className="flex items-center justify-center w-6 h-6 rounded border border-dashed border-purple-300 dark:border-purple-500/30 text-purple-600 dark:text-purple-500 hover:bg-purple-50/50 dark:hover:bg-purple-900/20 transition-colors"
          >
            <Plus className="w-3 h-3" />
          </button>
        )}

        {/* More tags tooltip */}
        {hasMoreTags && (
          <div
            ref={tooltipRef}
            className="cursor-pointer relative"
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setTooltipPosition({
                x: rect.left + rect.width / 2,
                y: rect.bottom + 8
              });
              setShowTooltip(true);
            }}
            onMouseLeave={() => {
              setShowTooltip(false);
              setTooltipPosition(null);
            }}
          >
            <Badge
              color="purple"
              variant="outline"
              className="bg-purple-100/50 dark:bg-purple-900/30 border-dashed text-xs"
            >
              +{remainingTags.length} more...
            </Badge>
          </div>
        )}
      </div>
      
      {/* Portal tooltip for proper z-index layering */}
      {showTooltip && tooltipPosition && createPortal(
        <div 
          className="fixed bg-black dark:bg-zinc-800 text-white text-xs rounded-lg py-2 px-3 shadow-lg z-[10001] whitespace-nowrap max-w-xs border border-purple-500/50 pointer-events-none"
          style={{
            left: tooltipPosition.x,
            top: tooltipPosition.y,
            transform: 'translateX(-50%)'
          }}
        >
          <div className="font-semibold text-purple-300 mb-1">
            Additional Tags:
          </div>
          {remainingTags.map((tag, index) => (
            <div key={index} className="text-gray-300">
              • {tag}
            </div>
          ))}
          <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-b-black dark:border-b-zinc-800"></div>
        </div>,
        document.body
      )}
      
      {/* Error display */}
      {validationError && (
        <div className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded px-2 py-1">
          {validationError}
        </div>
      )}
    </div>
  );
};