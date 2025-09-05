import { useCallback } from "react";
import { useToast } from "../../../ui/hooks/useToast";
import { useProjectFeatures } from "../../hooks/useProjectQueries";
import type { Assignee, CreateTaskRequest, Task, UpdateTaskRequest, UseTaskEditorReturn } from "../types";
import { useCreateTask, useUpdateTask } from "./useTaskQueries";

export const useTaskEditor = (projectId: string): UseTaskEditorReturn => {
  const { showToast } = useToast();

  // TanStack Query hooks
  const { data: featuresData, isLoading: isLoadingFeatures } = useProjectFeatures(projectId);
  const createTaskMutation = useCreateTask();
  const updateTaskMutation = useUpdateTask(projectId);

  // Transform features data
  const projectFeatures = (featuresData?.features || []) as Array<{
    id: string;
    label: string;
    type?: string;
    color?: string;
  }>;
  const isSaving = createTaskMutation.isPending || updateTaskMutation.isPending;

  // Get default order for new tasks based on status
  const getDefaultTaskOrder = useCallback((status: Task["status"]) => {
    // Simple priority mapping: todo=50, doing=25, review=75, done=100
    const statusOrderMap = { todo: 50, doing: 25, review: 75, done: 100 };
    return statusOrderMap[status] || 50;
  }, []);

  // Build update object with only changed fields
  const buildTaskUpdates = useCallback((localTask: Partial<Task>, editingTask: Task) => {
    const updates: UpdateTaskRequest = {};

    if (localTask.title !== editingTask.title) updates.title = localTask.title;
    if (localTask.description !== editingTask.description) updates.description = localTask.description;
    if (localTask.status !== editingTask.status) updates.status = localTask.status;
    if (localTask.assignee !== editingTask.assignee) updates.assignee = localTask.assignee || "User";
    if (localTask.task_order !== editingTask.task_order) updates.task_order = localTask.task_order;
    if (localTask.feature !== editingTask.feature) updates.feature = localTask.feature || "";

    return updates;
  }, []);

  // Build create request object
  const buildCreateRequest = useCallback(
    (localTask: Partial<Task>): CreateTaskRequest => {
      return {
        project_id: projectId,
        title: localTask.title || "",
        description: localTask.description || "",
        status: (localTask.status as Task["status"]) || "todo",
        assignee: (localTask.assignee as Assignee) || "User",
        feature: localTask.feature || "",
        task_order: localTask.task_order || getDefaultTaskOrder((localTask.status as Task["status"]) || "todo"),
      };
    },
    [projectId, getDefaultTaskOrder],
  );

  // Save task (create or update) with full validation
  const saveTask = useCallback(
    async (localTask: Partial<Task> | null, editingTask: Task | null, onSuccess?: () => void) => {
      // Validation moved here from component
      if (!localTask) {
        showToast("No task data provided", "error");
        return;
      }

      if (!localTask.title?.trim()) {
        showToast("Task title is required", "error");
        return;
      }

      if (editingTask?.id) {
        // Update existing task
        const updates = buildTaskUpdates(localTask, editingTask);

        updateTaskMutation.mutate(
          {
            taskId: editingTask.id,
            updates,
          },
          {
            onSuccess: () => {
              // Success toast handled by mutation
              onSuccess?.();
            },
            onError: (error) => {
              console.error("Failed to update task:", error);
              // Error toast handled by mutation
            },
          },
        );
      } else {
        // Create new task
        const newTaskData = buildCreateRequest(localTask);

        createTaskMutation.mutate(newTaskData, {
          onSuccess: () => {
            // Success toast handled by mutation
            onSuccess?.();
          },
          onError: (error) => {
            console.error("Failed to create task:", error);
            // Error toast handled by mutation
          },
        });
      }
    },
    [buildTaskUpdates, buildCreateRequest, updateTaskMutation, createTaskMutation, showToast],
  );

  return {
    // Data
    projectFeatures,

    // Actions
    saveTask,

    // Loading states
    isLoadingFeatures,
    isSaving,
  };
};
