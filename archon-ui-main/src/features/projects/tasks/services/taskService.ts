/**
 * Task Management Service
 * Focused service for task CRUD operations only
 */

import { callAPIWithETag } from "../../../shared/api/apiClient";
import { formatZodErrors, ValidationError } from "../../../shared/types/errors";

import { validateCreateTask, validateUpdateTask, validateUpdateTaskStatus } from "../schemas";
import type { CreateTaskRequest, DatabaseTaskStatus, Task, TaskCounts, UpdateTaskRequest } from "../types";

export const taskService = {
  /**
   * Get all tasks with optional filtering
   * Supports pagination, status filtering, and search
   */
  async getTasks(params?: {
    status?: DatabaseTaskStatus;
    project_id?: string;
    include_closed?: boolean;
    include_archived?: boolean;
    page?: number;
    per_page?: number;
    exclude_large_fields?: boolean;
    q?: string;
  }): Promise<{ tasks: Task[]; pagination: { total: number; page: number; per_page: number; pages: number } }> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.status) queryParams.append("status", params.status);
      if (params?.project_id) queryParams.append("project_id", params.project_id);
      if (params?.include_closed !== undefined) queryParams.append("include_closed", String(params.include_closed));
      if (params?.include_archived !== undefined)
        queryParams.append("include_archived", String(params.include_archived));
      if (params?.page) queryParams.append("page", String(params.page));
      if (params?.per_page) queryParams.append("per_page", String(params.per_page));
      if (params?.exclude_large_fields !== undefined)
        queryParams.append("exclude_large_fields", String(params.exclude_large_fields));
      if (params?.q) queryParams.append("q", params.q);

      const response = await callAPIWithETag<{
        tasks: Task[];
        pagination: { total: number; page: number; per_page: number; pages: number };
      }>(`/api/tasks?${queryParams.toString()}`);

      return response;
    } catch (error) {
      console.error("Failed to get tasks:", error);
      throw error;
    }
  },

  /**
   * Get all tasks for a project, optionally filtered by sprint
   */
  async getTasksByProject(projectId: string, includeArchived = false, sprintId?: string): Promise<Task[]> {
    try {
      const params = new URLSearchParams();
      if (includeArchived) params.set("include_archived", "true");
      if (sprintId) params.set("sprint_id", sprintId);
      const query = params.toString();
      const url = `/api/projects/${projectId}/tasks${query ? `?${query}` : ""}`;
      return callAPIWithETag<Task[]>(url);
    } catch (error) {
      console.error(`Failed to get tasks for project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Get a specific task by ID
   */
  async getTask(taskId: string): Promise<Task> {
    try {
      const task = await callAPIWithETag<Task>(`/api/tasks/${taskId}`);
      return task;
    } catch (error) {
      console.error(`Failed to get task ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Create a new task
   */
  async createTask(taskData: CreateTaskRequest): Promise<Task> {
    // Validate input
    const validation = validateCreateTask(taskData);
    if (!validation.success) {
      throw new ValidationError(formatZodErrors(validation.error));
    }

    try {
      // The validation.data already has defaults from schema
      const requestData = validation.data;

      // Backend returns { message: string, task: Task } for mutations
      const response = await callAPIWithETag<{ message: string; task: Task }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(requestData),
      });

      return response.task;
    } catch (error) {
      console.error("Failed to create task:", error);
      throw error;
    }
  },

  /**
   * Update an existing task
   */
  async updateTask(taskId: string, updates: UpdateTaskRequest): Promise<Task> {
    // Validate input
    const validation = validateUpdateTask(updates);
    if (!validation.success) {
      throw new ValidationError(formatZodErrors(validation.error));
    }

    try {
      // Backend returns { message: string, task: Task } for mutations
      const response = await callAPIWithETag<{ message: string; task: Task }>(`/api/tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify(validation.data),
      });

      return response.task;
    } catch (error) {
      console.error(`Failed to update task ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Update task status (for drag & drop operations)
   */
  async updateTaskStatus(taskId: string, status: DatabaseTaskStatus): Promise<Task> {
    // Validate input
    const validation = validateUpdateTaskStatus({
      task_id: taskId,
      status: status,
    });
    if (!validation.success) {
      throw new ValidationError(formatZodErrors(validation.error));
    }

    try {
      // Use the standard update task endpoint with JSON body
      // Backend returns { message: string, task: Task } for mutations
      const response = await callAPIWithETag<{ message: string; task: Task }>(`/api/tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });

      return response.task;
    } catch (error) {
      console.error(`Failed to update task status ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<void> {
    try {
      await callAPIWithETag<void>(`/api/tasks/${taskId}`, {
        method: "DELETE",
      });
    } catch (error) {
      console.error(`Failed to delete task ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Update task order for better drag-and-drop support
   */
  async updateTaskOrder(taskId: string, newOrder: number, newStatus?: DatabaseTaskStatus): Promise<Task> {
    try {
      const updates: UpdateTaskRequest = {
        task_order: newOrder,
      };

      if (newStatus) {
        updates.status = newStatus;
      }

      const task = await this.updateTask(taskId, updates);

      return task;
    } catch (error) {
      console.error(`Failed to update task order for ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Archive a task (soft-hide without deleting)
   */
  async archiveTask(taskId: string, reason?: string): Promise<void> {
    try {
      await callAPIWithETag<{ message: string }>(`/api/tasks/${taskId}/archive`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true, archived_reason: reason }),
      });
    } catch (error) {
      console.error(`Failed to archive task ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Unarchive a task (restore from soft-hide)
   */
  async unarchiveTask(taskId: string): Promise<void> {
    try {
      await callAPIWithETag<{ message: string }>(`/api/tasks/${taskId}/archive`, {
        method: "PATCH",
        body: JSON.stringify({ archived: false }),
      });
    } catch (error) {
      console.error(`Failed to unarchive task ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Get tasks by status across all projects
   */
  async getTasksByStatus(status: DatabaseTaskStatus): Promise<Task[]> {
    try {
      // Note: This method requires cross-project access
      // For now, we'll throw an error suggesting to use project-scoped queries
      throw new Error("getTasksByStatus requires cross-project access. Use getTasksByProject instead.");
    } catch (error) {
      console.error(`Failed to get tasks by status ${status}:`, error);
      throw error;
    }
  },

  /**
   * Get task counts for all projects in a single batch request
   * Optimized endpoint to avoid N+1 query problem
   */
  async getTaskCountsForAllProjects(): Promise<Record<string, TaskCounts>> {
    try {
      const response = await callAPIWithETag<Record<string, TaskCounts>>("/api/projects/task-counts");
      return response || {};
    } catch (error) {
      console.error("Failed to get task counts for all projects:", error);
      throw error;
    }
  },
};
