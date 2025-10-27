import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  ComboBox,
  type ComboBoxOption,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../ui/primitives";
import { cn } from "../../../ui/primitives/styles";
import { COMMON_ASSIGNEES } from "../types";

interface EditableTableCellProps {
  value: string;
  onSave: (value: string) => Promise<void>;
  type?: "text" | "select" | "status" | "assignee";
  options?: readonly string[];
  placeholder?: string;
  className?: string;
  isUpdating?: boolean;
}

// Status options for the status select
const STATUS_OPTIONS = ["todo", "doing", "review", "done"] as const;

// Convert common assignees to ComboBox options
const ASSIGNEE_OPTIONS: ComboBoxOption[] = COMMON_ASSIGNEES.map((name) => ({
  value: name,
  label: name,
}));

export const EditableTableCell = ({
  value,
  onSave,
  type = "text",
  options,
  placeholder = "Click to edit",
  className,
  isUpdating = false,
}: EditableTableCellProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Update edit value when prop changes
  useEffect(() => {
    setEditValue(value);
  }, [value]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = async () => {
    if (editValue === value) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await onSave(editValue);
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to save:", error);
      // Reset on error
      setEditValue(value);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  // Get the appropriate options based on type
  const selectOptions = type === "status" ? STATUS_OPTIONS : options || [];

  if (!isEditing) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: Table cell transforms into input on click - can't use semantic button
      <div
        role="button"
        tabIndex={0}
        onClick={() => !isUpdating && setIsEditing(true)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !isUpdating) {
            e.preventDefault();
            setIsEditing(true);
          }
        }}
        className={cn(
          "cursor-pointer px-2 py-1 min-h-[28px]",
          "hover:bg-gray-100/50 dark:hover:bg-gray-800/50",
          "rounded transition-colors",
          "flex items-center",
          isUpdating && "opacity-50 cursor-not-allowed",
          className,
        )}
        title={value || placeholder}
      >
        <span className={cn(!value && "text-gray-400 italic")}>
          {/* Truncate long assignee names */}
          {type === "assignee" && value && value.length > 20 ? `${value.slice(0, 17)}...` : value || placeholder}
        </span>
      </div>
    );
  }

  // Render ComboBox for assignee type
  if (type === "assignee") {
    return (
      <ComboBox
        options={ASSIGNEE_OPTIONS}
        value={editValue}
        onValueChange={(newValue) => {
          setEditValue(newValue);
          // Auto-save on change
          setTimeout(() => {
            onSave(newValue);
            setIsEditing(false);
          }, 0);
        }}
        placeholder="Select assignee..."
        searchPlaceholder="Assign to..."
        emptyMessage="Press Enter to add"
        className={cn("w-full h-7 text-sm", className)}
        allowCustomValue={true}
        disabled={isSaving}
      />
    );
  }

  // Render select for select/status types
  if (type === "select" || type === "status") {
    return (
      <Select
        value={editValue}
        onValueChange={(newValue) => {
          setEditValue(newValue);
          // Auto-save on select
          setTimeout(() => {
            setEditValue(newValue);
            onSave(newValue);
            setIsEditing(false);
          }, 0);
        }}
        disabled={isSaving}
      >
        <SelectTrigger
          className={cn(
            "w-full h-7 text-sm",
            "border-cyan-400 dark:border-cyan-600",
            "focus:ring-1 focus:ring-cyan-400",
            className,
          )}
          onKeyDown={handleKeyDown}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {selectOptions.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  // Render input for text type
  return (
    <Input
      ref={inputRef}
      value={editValue}
      onChange={(e) => setEditValue(e.target.value)}
      onBlur={handleSave}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      disabled={isSaving}
      className={cn(
        "h-7 text-sm",
        "border-cyan-400 dark:border-cyan-600",
        "focus:ring-1 focus:ring-cyan-400",
        className,
      )}
    />
  );
};
