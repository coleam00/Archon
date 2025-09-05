import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSmartPolling } from "../../../ui/hooks";
import { useToast } from "../../../ui/hooks/useToast";
import { projectKeys } from "../../hooks/useProjectQueries";
import { taskService } from "../services";
import type { CreateTaskRequest, Task, UpdateTaskRequest } from "../types";

// Query keys factory for tasks
export const taskKeys = {
  all: (projectId: string) => ["projects", projectId, "tasks"] as const,
};

// Fetch tasks for a specific project
export function useProjectTasks(projectId: string | undefined, enabled = true) {
  const { refetchInterval } = useSmartPolling(5000); // 5 second base interval for faster MCP updates

  return useQuery<Task[]>({
    queryKey: projectId ? taskKeys.all(projectId) : ["tasks-undefined"],
    queryFn: async () => {
      if (!projectId) throw new Error("No project ID");
      return taskService.getTasksByProject(projectId);
    },
    enabled: !!projectId && enabled,
    refetchInterval, // Smart interval based on page visibility/focus
    refetchOnWindowFocus: true, // Refetch immediately when tab gains focus (ETag makes this cheap)
    staleTime: 10000, // Consider data stale after 10 seconds
  });
}

// Create task mutation with optimistic updates
export function useCreateTask() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (taskData: CreateTaskRequest) => taskService.createTask(taskData),
    onMutate: async (newTaskData) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: taskKeys.all(newTaskData.project_id) });

      // Snapshot the previous value
      const previousTasks = queryClient.getQueryData(taskKeys.all(newTaskData.project_id));

      // Create optimistic task with temporary ID
      const tempId = `temp-${Date.now()}`;
      const optimisticTask: Task = {
        id: tempId, // Temporary ID until real one comes back
        ...newTaskData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        // Ensure all required fields have defaults
        task_order: newTaskData.task_order ?? 100,
        status: newTaskData.status ?? "todo",
        assignee: newTaskData.assignee ?? "User",
      } as Task;

      // Optimistically add the new task
      queryClient.setQueryData(taskKeys.all(newTaskData.project_id), (old: Task[] | undefined) => {
        if (!old) return [optimisticTask];
        return [...old, optimisticTask];
      });

      return { previousTasks, tempId };
    },
    onError: (error, variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to create task:", error, { variables });
      // Rollback on error
      if (context?.previousTasks) {
        queryClient.setQueryData(taskKeys.all(variables.project_id), context.previousTasks);
      }
      showToast(`Failed to create task: ${errorMessage}`, "error");
    },
    onSuccess: (data, variables, context) => {
      // Replace optimistic task with real one from server
      queryClient.setQueryData(taskKeys.all(variables.project_id), (old: Task[] | undefined) => {
        if (!old) return [data];
        // Replace only the specific temp task with real one
        return old
          .map((task) => (task.id === context?.tempId ? data : task))
          .filter(
            (task, index, self) =>
              // Remove any duplicates just in case
              index === self.findIndex((t) => t.id === task.id),
          );
      });
      queryClient.invalidateQueries({ queryKey: projectKeys.taskCounts() });
      showToast("Task created successfully", "success");
    },
    onSettled: (_data, _error, variables) => {
      // Always refetch to ensure consistency after operation completes
      queryClient.invalidateQueries({ queryKey: taskKeys.all(variables.project_id) });
    },
  });
}

// Update task mutation with optimistic updates
export function useUpdateTask(projectId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<Task, Error, { taskId: string; updates: UpdateTaskRequest }, { previousTasks?: Task[] }>({
    mutationFn: ({ taskId, updates }: { taskId: string; updates: UpdateTaskRequest }) =>
      taskService.updateTask(taskId, updates),
    onMutate: async ({ taskId, updates }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: taskKeys.all(projectId) });

      // Snapshot the previous value
      const previousTasks = queryClient.getQueryData<Task[]>(taskKeys.all(projectId));

      // Optimistically update
      queryClient.setQueryData<Task[]>(taskKeys.all(projectId), (old) => {
        if (!old) return old;
        return old.map((task) => (task.id === taskId ? { ...task, ...updates } : task));
      });

      return { previousTasks };
    },
    onError: (error, variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to update task:", error, { variables });
      // Rollback on error
      if (context?.previousTasks) {
        queryClient.setQueryData(taskKeys.all(projectId), context.previousTasks);
      }
      showToast(`Failed to update task: ${errorMessage}`, "error");
      // Refetch on error to ensure consistency
      queryClient.invalidateQueries({ queryKey: taskKeys.all(projectId) });
      queryClient.invalidateQueries({ queryKey: projectKeys.taskCounts() });
    },
    onSuccess: (data, { updates }) => {
      // Merge server response to keep timestamps and computed fields in sync
      queryClient.setQueryData<Task[]>(taskKeys.all(projectId), (old) =>
        old ? old.map((t) => (t.id === data.id ? data : t)) : old,
      );
      // Only invalidate counts if status changed (which affects counts)
      if (updates.status) {
        queryClient.invalidateQueries({ queryKey: projectKeys.taskCounts() });
        // Show toast for significant status changes
        showToast(`Task moved to ${updates.status}`, "success");
      }
    },
  });
}

// Delete task mutation
export function useDeleteTask(projectId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<void, Error, string, { previousTasks?: Task[] }>({
    mutationFn: (taskId: string) => taskService.deleteTask(taskId),
    onMutate: async (taskId) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: taskKeys.all(projectId) });

      // Snapshot the previous value
      const previousTasks = queryClient.getQueryData<Task[]>(taskKeys.all(projectId));

      // Optimistically remove the task
      queryClient.setQueryData<Task[]>(taskKeys.all(projectId), (old) => {
        if (!old) return old;
        return old.filter((task) => task.id !== taskId);
      });

      return { previousTasks };
    },
    onError: (error, taskId, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to delete task:", error, { taskId });
      // Rollback on error
      if (context?.previousTasks) {
        queryClient.setQueryData(taskKeys.all(projectId), context.previousTasks);
      }
      showToast(`Failed to delete task: ${errorMessage}`, "error");
    },
    onSuccess: () => {
      showToast("Task deleted successfully", "success");
    },
    onSettled: () => {
      // Always refetch counts after deletion
      queryClient.invalidateQueries({ queryKey: projectKeys.taskCounts() });
    },
  });
}
