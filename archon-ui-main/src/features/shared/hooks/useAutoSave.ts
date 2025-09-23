/**
 * useAutoSave Hook
 * A generic hook for handling auto-save functionality with debouncing,
 * error handling, and loading states for editable components.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseAutoSaveOptions<T> {
  /** The current value to save */
  value: T;
  /** Function to save the value - should return a promise */
  onSave: (value: T) => Promise<void>;
  /** Delay in ms before auto-saving after value changes (default: 500ms) */
  debounceMs?: number;
  /** Whether to validate before saving (default: true) */
  validate?: (value: T) => boolean;
  /** Function to transform value before saving */
  transform?: (value: T) => T;
  /** Whether the component is currently in editing mode */
  isEditing?: boolean;
}

export interface UseAutoSaveReturn<T> {
  /** Current edit value */
  editValue: T;
  /** Set the edit value */
  setEditValue: (value: T) => void;
  /** Whether a save operation is in progress */
  isSaving: boolean;
  /** Whether there are unsaved changes */
  hasUnsavedChanges: boolean;
  /** Manually trigger save */
  save: () => Promise<void>;
  /** Cancel edit and revert to original value */
  cancel: () => void;
  /** Reset edit value to current prop value */
  reset: () => void;
  /** Whether the last save operation failed */
  hasError: boolean;
}

/**
 * Generic auto-save hook for editable components
 */
export function useAutoSave<T>({
  value,
  onSave,
  debounceMs = 500,
  validate = () => true,
  transform,
  isEditing = false,
}: UseAutoSaveOptions<T>): UseAutoSaveReturn<T> {
  const [editValue, setEditValue] = useState<T>(value);
  const [isSaving, setIsSaving] = useState(false);
  const [hasError, setHasError] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout>();
  const isEditingRef = useRef(isEditing);

  // Update refs
  isEditingRef.current = isEditing;

  // Update edit value when prop changes, but only when not editing
  useEffect(() => {
    if (!isEditingRef.current) {
      setEditValue(value);
    }
  }, [value]);

  // Clear error when editing starts
  useEffect(() => {
    if (isEditing) {
      setHasError(false);
    }
  }, [isEditing]);

  const hasUnsavedChanges = editValue !== value;

  const performSave = useCallback(
    async (valueToSave: T): Promise<void> => {
      // Don't save if value hasn't changed
      if (valueToSave === value) {
        return;
      }

      // Validate before saving
      if (!validate(valueToSave)) {
        return;
      }

      // Transform value if needed
      const finalValue = transform ? transform(valueToSave) : valueToSave;

      setIsSaving(true);
      setHasError(false);

      try {
        await onSave(finalValue);
      } catch (error) {
        console.error("Save failed:", error);
        setHasError(true);
        // Reset to original value on error
        setEditValue(value);
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [value, onSave, validate, transform],
  );

  const save = useCallback(async (): Promise<void> => {
    // Clear any pending debounced save
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }

    await performSave(editValue);
  }, [editValue, performSave]);

  const cancel = useCallback(() => {
    // Clear any pending debounced save
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }

    setEditValue(value);
    setHasError(false);
  }, [value]);

  const reset = useCallback(() => {
    setEditValue(value);
    setHasError(false);
  }, [value]);

  // Debounced auto-save when editValue changes
  useEffect(() => {
    if (!isEditingRef.current || editValue === value) {
      return;
    }

    // Clear previous timeout
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Set new timeout
    debounceRef.current = setTimeout(() => {
      performSave(editValue).catch(() => {
        // Error handling is done in performSave
      });
    }, debounceMs);

    // Cleanup function
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [editValue, value, debounceMs, performSave]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  return {
    editValue,
    setEditValue,
    isSaving,
    hasUnsavedChanges,
    save,
    cancel,
    reset,
    hasError,
  };
}

/**
 * Specialized hook for string values with trimming and empty validation
 */
export function useAutoSaveString(
  options: Omit<UseAutoSaveOptions<string>, "validate" | "transform"> & {
    /** Whether to allow empty strings (default: false) */
    allowEmpty?: boolean;
    /** Whether to trim whitespace before saving (default: true) */
    trimValue?: boolean;
  },
): UseAutoSaveReturn<string> {
  const { allowEmpty = false, trimValue = true, ...restOptions } = options;

  return useAutoSave({
    ...restOptions,
    validate: (value: string) => {
      const trimmed = trimValue ? value.trim() : value;
      return allowEmpty || trimmed.length > 0;
    },
    transform: trimValue ? (value: string) => value.trim() : undefined,
  });
}
