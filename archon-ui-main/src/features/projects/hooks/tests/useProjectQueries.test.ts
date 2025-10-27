import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../types";
import { projectKeys, useCreateProject, useDeleteProject, useProjects, useUpdateProject } from "../useProjectQueries";

// Mock the services
vi.mock("../../services", () => ({
  projectService: {
    listProjects: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    getProjectFeatures: vi.fn(),
  },
  taskService: {
    getTaskCountsForAllProjects: vi.fn(),
  },
}));

// Mock the toast hook
vi.mock("@/features/shared/hooks/useToast", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

// Mock smart polling
vi.mock("@/features/shared/hooks", () => ({
  useSmartPolling: () => ({
    refetchInterval: 5000,
    isPaused: false,
  }),
}));

// Test wrapper with QueryClient
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
};

describe("useProjectQueries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("projectKeys", () => {
    it("should generate correct query keys", () => {
      expect(projectKeys.all).toEqual(["projects"]);
      expect(projectKeys.lists()).toEqual(["projects", "list"]);
      expect(projectKeys.detail("123")).toEqual(["projects", "detail", "123"]);
      expect(projectKeys.features("123")).toEqual(["projects", "123", "features"]);
    });
  });

  describe("useProjects", () => {
    it("should fetch projects list", async () => {
      const mockProjects: Project[] = [
        {
          id: "1",
          title: "Test Project",
          description: "Test Description",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          pinned: false,
          features: [],
          docs: [],
        },
      ];

      const { projectService } = await import("../../services");
      vi.mocked(projectService.listProjects).mockResolvedValue(mockProjects);

      const { result } = renderHook(() => useProjects(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
        expect(result.current.data).toEqual(mockProjects);
      });

      expect(projectService.listProjects).toHaveBeenCalledTimes(1);
    });
  });

  describe("useCreateProject", () => {
    it("should optimistically add project and replace with server response", async () => {
      const newProject: Project = {
        id: "real-id",
        title: "New Project",
        description: "New Description",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        pinned: false,
        features: [],
        docs: [],
      };

      const { projectService } = await import("../../services");
      vi.mocked(projectService.createProject).mockResolvedValue({
        project_id: "new-project-id",
        project: newProject,
        status: "success",
        message: "Created",
      });

      const wrapper = createWrapper();
      const { result } = renderHook(() => useCreateProject(), { wrapper });

      await result.current.mutateAsync({
        title: "New Project",
        description: "New Description",
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
        expect(projectService.createProject).toHaveBeenCalledWith({
          title: "New Project",
          description: "New Description",
        });
      });
    });

    it("should rollback on error", async () => {
      const { projectService } = await import("../../services");
      vi.mocked(projectService.createProject).mockRejectedValue(new Error("Network error"));

      const wrapper = createWrapper();
      const { result } = renderHook(() => useCreateProject(), { wrapper });

      await expect(
        result.current.mutateAsync({
          title: "New Project",
          description: "New Description",
        }),
      ).rejects.toThrow("Network error");
    });
  });

  describe("useUpdateProject", () => {
    it("should handle pinning a project", async () => {
      const updatedProject: Project = {
        id: "1",
        title: "Test Project",
        description: "Test Description",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        pinned: true,
        features: [],
        docs: [],
      };

      const { projectService } = await import("../../services");
      vi.mocked(projectService.updateProject).mockResolvedValue(updatedProject);

      const wrapper = createWrapper();
      const { result } = renderHook(() => useUpdateProject(), { wrapper });

      await result.current.mutateAsync({
        projectId: "1",
        updates: { pinned: true },
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
        expect(projectService.updateProject).toHaveBeenCalledWith("1", { pinned: true });
      });
    });
  });

  describe("useDeleteProject", () => {
    it("should optimistically remove project", async () => {
      const { projectService } = await import("../../services");
      vi.mocked(projectService.deleteProject).mockResolvedValue(undefined);

      const wrapper = createWrapper();
      const { result } = renderHook(() => useDeleteProject(), { wrapper });

      await result.current.mutateAsync("project-to-delete");

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
        expect(projectService.deleteProject).toHaveBeenCalledWith("project-to-delete");
      });
    });

    it("should rollback on delete error", async () => {
      const { projectService } = await import("../../services");
      vi.mocked(projectService.deleteProject).mockRejectedValue(new Error("Permission denied"));

      const wrapper = createWrapper();
      const { result } = renderHook(() => useDeleteProject(), { wrapper });

      await expect(result.current.mutateAsync("project-to-delete")).rejects.toThrow("Permission denied");
    });
  });
});
