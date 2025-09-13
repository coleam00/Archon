import { useCallback, useState } from "react";
import type { Assignee, Task, TaskPriority, UseTaskActionsReturn } from "../types";
import { useDeleteTask, useUpdateTask } from "./useTaskQueries";

export const useTaskActions = (projectId: string): UseTaskActionsReturn => {
  const updateTaskMutation = useUpdateTask(projectId);
  const deleteTaskMutation = useDeleteTask(projectId);

  // Delete confirmation state - store full task object for proper modal display
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<Task | null>(null);

  // Assignee change handler
  const changeAssignee = useCallback(
    (taskId: string, newAssignee: string) => {
      updateTaskMutation.mutate({
        taskId,
        updates: { assignee: newAssignee as Assignee },
      });
    },
    [updateTaskMutation],
  );

  // Priority change handler
  const changePriority = useCallback(
    (taskId: string, newPriority: TaskPriority) => {
      updateTaskMutation.mutate({
        taskId,
        updates: { priority: newPriority },
      });
    },
    [updateTaskMutation],
  );

  // Delete task handler with confirmation flow - now accepts full task object
  const initiateDelete = useCallback((task: Task) => {
    setTaskToDelete(task);
    setShowDeleteConfirm(true);
  }, []);

  // Confirm and execute deletion
  const confirmDelete = useCallback(() => {
    if (!taskToDelete) return;

    deleteTaskMutation.mutate(taskToDelete.id, {
      onSuccess: () => {
        // Success toast handled by mutation
        setShowDeleteConfirm(false);
        setTaskToDelete(null);
      },
      onError: (error) => {
        console.error("Failed to delete task:", error, { taskToDelete });
        // Error toast handled by mutation
        // Modal stays open on error so user can retry
      },
    });
  }, [deleteTaskMutation, taskToDelete]);

  // Cancel deletion
  const cancelDelete = useCallback(() => {
    setShowDeleteConfirm(false);
    setTaskToDelete(null);
  }, []);

  return {
    // Actions
    changeAssignee,
    changePriority,
    initiateDelete,
    confirmDelete,
    cancelDelete,

    // State
    showDeleteConfirm,
    taskToDelete,

    // Loading states
    isUpdating: updateTaskMutation.isPending,
    isDeleting: deleteTaskMutation.isPending,
  };
};
