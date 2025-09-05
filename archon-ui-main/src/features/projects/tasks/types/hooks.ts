/**
 * Hook Type Definitions
 *
 * Type definitions for task-related hooks
 */

import type { Task } from "./task";

/**
 * Return type for useTaskActions hook
 */
export interface UseTaskActionsReturn {
  // Actions
  changeAssignee: (taskId: string, newAssignee: string) => void;
  initiateDelete: (task: Task) => void;
  confirmDelete: () => void;
  cancelDelete: () => void;

  // State
  showDeleteConfirm: boolean;
  taskToDelete: Task | null;

  // Loading states
  isUpdating: boolean;
  isDeleting: boolean;
}

/**
 * Return type for useTaskEditor hook
 */
export interface UseTaskEditorReturn {
  // Data
  projectFeatures: Array<{
    id: string;
    label: string;
    type?: string;
    color?: string;
  }>;

  // Actions
  saveTask: (localTask: Partial<Task> | null, editingTask: Task | null, onSuccess?: () => void) => void;

  // Loading states
  isLoadingFeatures: boolean;
  isSaving: boolean;
}
