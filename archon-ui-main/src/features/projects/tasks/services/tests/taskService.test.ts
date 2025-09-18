import { beforeEach, describe, expect, it, vi } from "vitest";
import { callAPIWithETag } from "../../../../shared/apiWithEtag";
import type { CreateTaskRequest, DatabaseTaskStatus, Task, UpdateTaskRequest } from "../../types";
import { taskService } from "../taskService";

// Mock the API call
vi.mock("../../../../shared/apiWithEtag", () => ({
  callAPIWithETag: vi.fn(),
}));

// Mock the validation functions
vi.mock("../../schemas", () => ({
  validateCreateTask: vi.fn((data) => ({ success: true, data })),
  validateUpdateTask: vi.fn((data) => ({ success: true, data })),
  validateUpdateTaskStatus: vi.fn((data) => ({ success: true, data })),
}));

describe("taskService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createTask", () => {
    const mockTaskData: CreateTaskRequest = {
      project_id: "test-project-id",
      title: "Test Task",
      description: "Test Description",
      status: "todo",
      assignee: "User",
      task_order: 50,
      priority: "medium",
      feature: "test-feature",
    };

    const mockTask: Task = {
      id: "task-123",
      ...mockTaskData,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    it("should create a task and unwrap the response correctly", async () => {
      // Backend returns wrapped response
      const mockResponse = {
        message: "Task created successfully",
        task: mockTask,
      };

      (callAPIWithETag as any).mockResolvedValueOnce(mockResponse);

      const result = await taskService.createTask(mockTaskData);

      // Verify the API was called correctly
      expect(callAPIWithETag).toHaveBeenCalledWith("/api/tasks", {
        method: "POST",
        body: JSON.stringify(mockTaskData),
      });

      // Verify the task is properly unwrapped
      expect(result).toEqual(mockTask);
      expect(result).not.toHaveProperty("message");
    });

    it("should handle API errors properly", async () => {
      const errorMessage = "Failed to create task";
      (callAPIWithETag as any).mockRejectedValueOnce(new Error(errorMessage));

      await expect(taskService.createTask(mockTaskData)).rejects.toThrow(errorMessage);
    });
  });

  describe("updateTask", () => {
    const taskId = "task-123";
    const mockUpdates: UpdateTaskRequest = {
      title: "Updated Task",
      description: "Updated Description",
      status: "doing",
      priority: "high",
    };

    const mockUpdatedTask: Task = {
      id: taskId,
      project_id: "test-project-id",
      title: mockUpdates.title!,
      description: mockUpdates.description!,
      status: mockUpdates.status as DatabaseTaskStatus,
      assignee: "User",
      task_order: 50,
      priority: mockUpdates.priority!,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
    };

    it("should update a task and unwrap the response correctly", async () => {
      // Backend returns wrapped response
      const mockResponse = {
        message: "Task updated successfully",
        task: mockUpdatedTask,
      };

      (callAPIWithETag as any).mockResolvedValueOnce(mockResponse);

      const result = await taskService.updateTask(taskId, mockUpdates);

      // Verify the API was called correctly
      expect(callAPIWithETag).toHaveBeenCalledWith(`/api/tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify(mockUpdates),
      });

      // Verify the task is properly unwrapped
      expect(result).toEqual(mockUpdatedTask);
      expect(result).not.toHaveProperty("message");
    });

    it("should handle partial updates correctly", async () => {
      const partialUpdate: UpdateTaskRequest = {
        description: "Only updating description",
      };

      const mockResponse = {
        message: "Task updated successfully",
        task: {
          ...mockUpdatedTask,
          description: partialUpdate.description!,
        },
      };

      (callAPIWithETag as any).mockResolvedValueOnce(mockResponse);

      const result = await taskService.updateTask(taskId, partialUpdate);

      expect(callAPIWithETag).toHaveBeenCalledWith(`/api/tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify(partialUpdate),
      });

      expect(result.description).toBe(partialUpdate.description);
    });

    it("should handle API errors properly", async () => {
      const errorMessage = "Failed to update task";
      (callAPIWithETag as any).mockRejectedValueOnce(new Error(errorMessage));

      await expect(taskService.updateTask(taskId, mockUpdates)).rejects.toThrow(errorMessage);
    });
  });

  describe("updateTaskStatus", () => {
    const taskId = "task-123";
    const newStatus: DatabaseTaskStatus = "review";

    const mockUpdatedTask: Task = {
      id: taskId,
      project_id: "test-project-id",
      title: "Test Task",
      description: "Test Description",
      status: newStatus,
      assignee: "User",
      task_order: 50,
      priority: "medium",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
    };

    it("should update task status and unwrap the response correctly", async () => {
      // Backend returns wrapped response
      const mockResponse = {
        message: "Task updated successfully",
        task: mockUpdatedTask,
      };

      (callAPIWithETag as any).mockResolvedValueOnce(mockResponse);

      const result = await taskService.updateTaskStatus(taskId, newStatus);

      // Verify the API was called correctly
      expect(callAPIWithETag).toHaveBeenCalledWith(`/api/tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus }),
      });

      // Verify the task is properly unwrapped
      expect(result).toEqual(mockUpdatedTask);
      expect(result).not.toHaveProperty("message");
      expect(result.status).toBe(newStatus);
    });

    it("should handle API errors properly", async () => {
      const errorMessage = "Failed to update task status";
      (callAPIWithETag as any).mockRejectedValueOnce(new Error(errorMessage));

      await expect(taskService.updateTaskStatus(taskId, newStatus)).rejects.toThrow(errorMessage);
    });
  });

  describe("deleteTask", () => {
    const taskId = "task-123";

    it("should delete a task successfully", async () => {
      // DELETE typically returns void/204 No Content
      (callAPIWithETag as any).mockResolvedValueOnce(undefined);

      await taskService.deleteTask(taskId);

      expect(callAPIWithETag).toHaveBeenCalledWith(`/api/tasks/${taskId}`, {
        method: "DELETE",
      });
    });

    it("should handle API errors properly", async () => {
      const errorMessage = "Failed to delete task";
      (callAPIWithETag as any).mockRejectedValueOnce(new Error(errorMessage));

      await expect(taskService.deleteTask(taskId)).rejects.toThrow(errorMessage);
    });
  });

  describe("getTasksByProject", () => {
    const projectId = "project-123";
    const mockTasks: Task[] = [
      {
        id: "task-1",
        project_id: projectId,
        title: "Task 1",
        description: "Description 1",
        status: "todo",
        assignee: "User",
        task_order: 50,
        priority: "low",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      },
      {
        id: "task-2",
        project_id: projectId,
        title: "Task 2",
        description: "Description 2",
        status: "doing",
        assignee: "Archon",
        task_order: 75,
        priority: "high",
        created_at: "2024-01-02T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      },
    ];

    it("should fetch tasks for a project", async () => {
      // GET endpoints typically return direct arrays
      (callAPIWithETag as any).mockResolvedValueOnce(mockTasks);

      const result = await taskService.getTasksByProject(projectId);

      expect(callAPIWithETag).toHaveBeenCalledWith(`/api/projects/${projectId}/tasks`);
      expect(result).toEqual(mockTasks);
      expect(result).toHaveLength(2);
    });

    it("should handle empty task list", async () => {
      (callAPIWithETag as any).mockResolvedValueOnce([]);

      const result = await taskService.getTasksByProject(projectId);

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    it("should handle API errors properly", async () => {
      const errorMessage = "Failed to fetch tasks";
      (callAPIWithETag as any).mockRejectedValueOnce(new Error(errorMessage));

      await expect(taskService.getTasksByProject(projectId)).rejects.toThrow(errorMessage);
    });
  });

  describe("Response unwrapping regression tests", () => {
    it("should preserve all task fields when unwrapping create response", async () => {
      const fullTaskData: CreateTaskRequest = {
        project_id: "project-123",
        title: "Full Task",
        description: "This is a detailed description that should persist",
        status: "todo",
        assignee: "Coding Agent",
        task_order: 100,
        priority: "critical",
        feature: "authentication",
      };

      const fullTask: Task = {
        id: "task-full",
        ...fullTaskData,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        // Additional fields that might be added by backend
        sources: [],
        code_examples: [],
      };

      const mockResponse = {
        message: "Task created successfully",
        task: fullTask,
      };

      (callAPIWithETag as any).mockResolvedValueOnce(mockResponse);

      const result = await taskService.createTask(fullTaskData);

      // Verify all fields are preserved
      expect(result.id).toBe("task-full");
      expect(result.title).toBe(fullTaskData.title);
      expect(result.description).toBe(fullTaskData.description);
      expect(result.status).toBe(fullTaskData.status);
      expect(result.assignee).toBe(fullTaskData.assignee);
      expect(result.task_order).toBe(fullTaskData.task_order);
      expect(result.priority).toBe(fullTaskData.priority);
      expect(result.feature).toBe(fullTaskData.feature);
      expect(result.sources).toEqual([]);
      expect(result.code_examples).toEqual([]);
    });

    it("should preserve description field specifically when updating", async () => {
      const taskId = "task-desc";
      const updateWithDescription: UpdateTaskRequest = {
        description: "This is a new description that must persist after refresh",
      };

      const updatedTask: Task = {
        id: taskId,
        project_id: "project-123",
        title: "Existing Task",
        description: updateWithDescription.description!,
        status: "todo",
        assignee: "User",
        task_order: 50,
        priority: "medium",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      };

      const mockResponse = {
        message: "Task updated successfully",
        task: updatedTask,
      };

      (callAPIWithETag as any).mockResolvedValueOnce(mockResponse);

      const result = await taskService.updateTask(taskId, updateWithDescription);

      // Specifically verify description is preserved
      expect(result.description).toBe("This is a new description that must persist after refresh");
      expect(result.description).toBe(updateWithDescription.description);
    });

    it("should handle wrapped response with nested task object correctly", async () => {
      const taskId = "task-nested";
      const updates: UpdateTaskRequest = {
        title: "Updated Title",
      };

      // Simulate deeply nested response structure
      const mockResponse = {
        message: "Task updated successfully",
        task: {
          id: taskId,
          project_id: "project-123",
          title: updates.title!,
          description: "Existing description",
          status: "doing" as DatabaseTaskStatus,
          assignee: "User",
          task_order: 50,
          priority: "medium",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
        },
        metadata: {
          updated_by: "api",
          timestamp: "2024-01-02T00:00:00Z",
        },
      };

      (callAPIWithETag as any).mockResolvedValueOnce(mockResponse);

      const result = await taskService.updateTask(taskId, updates);

      // Verify we extract only the task, not the wrapper
      expect(result).toEqual(mockResponse.task);
      expect(result).not.toHaveProperty("message");
      expect(result).not.toHaveProperty("metadata");
    });
  });
});
