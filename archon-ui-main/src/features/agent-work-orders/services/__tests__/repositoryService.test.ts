/**
 * Repository Service Tests
 *
 * Unit tests for repository service methods.
 * Mocks callAPIWithETag to test request structure and response handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfiguredRepository, CreateRepositoryRequest, UpdateRepositoryRequest } from "../../types/repository";
import { repositoryService } from "../repositoryService";

// Mock the API client
vi.mock("@/features/shared/api/apiClient", () => ({
  callAPIWithETag: vi.fn(),
}));

// Import after mocking
import { callAPIWithETag } from "@/features/shared/api/apiClient";

describe("repositoryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listRepositories", () => {
    it("should call GET /api/agent-work-orders/repositories", async () => {
      const mockRepositories: ConfiguredRepository[] = [
        {
          id: "repo-1",
          repository_url: "https://github.com/test/repo",
          display_name: "test/repo",
          owner: "test",
          default_branch: "main",
          is_verified: true,
          last_verified_at: "2024-01-01T00:00:00Z",
          default_sandbox_type: "git_worktree",
          default_commands: ["create-branch", "planning", "execute"],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ];

      vi.mocked(callAPIWithETag).mockResolvedValue(mockRepositories);

      const result = await repositoryService.listRepositories();

      expect(callAPIWithETag).toHaveBeenCalledWith("/api/agent-work-orders/repositories", {
        method: "GET",
      });
      expect(result).toEqual(mockRepositories);
    });

    it("should handle empty repository list", async () => {
      vi.mocked(callAPIWithETag).mockResolvedValue([]);

      const result = await repositoryService.listRepositories();

      expect(result).toEqual([]);
    });

    it("should propagate API errors", async () => {
      const error = new Error("Network error");
      vi.mocked(callAPIWithETag).mockRejectedValue(error);

      await expect(repositoryService.listRepositories()).rejects.toThrow("Network error");
    });
  });

  describe("createRepository", () => {
    it("should call POST /api/agent-work-orders/repositories with request body", async () => {
      const request: CreateRepositoryRequest = {
        repository_url: "https://github.com/test/repo",
        verify: true,
      };

      const mockResponse: ConfiguredRepository = {
        id: "repo-1",
        repository_url: "https://github.com/test/repo",
        display_name: "test/repo",
        owner: "test",
        default_branch: "main",
        is_verified: true,
        last_verified_at: "2024-01-01T00:00:00Z",
        default_sandbox_type: "git_worktree",
        default_commands: ["create-branch", "planning", "execute", "commit", "create-pr"],
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      };

      vi.mocked(callAPIWithETag).mockResolvedValue(mockResponse);

      const result = await repositoryService.createRepository(request);

      expect(callAPIWithETag).toHaveBeenCalledWith("/api/agent-work-orders/repositories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
      expect(result).toEqual(mockResponse);
    });

    it("should handle creation without verification", async () => {
      const request: CreateRepositoryRequest = {
        repository_url: "https://github.com/test/repo",
        verify: false,
      };

      const mockResponse: ConfiguredRepository = {
        id: "repo-1",
        repository_url: "https://github.com/test/repo",
        display_name: null,
        owner: null,
        default_branch: null,
        is_verified: false,
        last_verified_at: null,
        default_sandbox_type: "git_worktree",
        default_commands: ["create-branch", "planning", "execute", "commit", "create-pr"],
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      };

      vi.mocked(callAPIWithETag).mockResolvedValue(mockResponse);

      const result = await repositoryService.createRepository(request);

      expect(result.is_verified).toBe(false);
      expect(result.display_name).toBe(null);
    });

    it("should propagate validation errors", async () => {
      const error = new Error("Invalid repository URL");
      vi.mocked(callAPIWithETag).mockRejectedValue(error);

      await expect(
        repositoryService.createRepository({
          repository_url: "invalid-url",
        }),
      ).rejects.toThrow("Invalid repository URL");
    });
  });

  describe("updateRepository", () => {
    it("should call PATCH /api/agent-work-orders/repositories/:id with update request", async () => {
      const id = "repo-1";
      const request: UpdateRepositoryRequest = {
        default_sandbox_type: "git_branch",
        default_commands: ["create-branch", "planning", "execute"],
      };

      const mockResponse: ConfiguredRepository = {
        id: "repo-1",
        repository_url: "https://github.com/test/repo",
        display_name: "test/repo",
        owner: "test",
        default_branch: "main",
        is_verified: true,
        last_verified_at: "2024-01-01T00:00:00Z",
        default_sandbox_type: "git_branch",
        default_commands: ["create-branch", "planning", "execute"],
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      };

      vi.mocked(callAPIWithETag).mockResolvedValue(mockResponse);

      const result = await repositoryService.updateRepository(id, request);

      expect(callAPIWithETag).toHaveBeenCalledWith(`/api/agent-work-orders/repositories/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
      expect(result).toEqual(mockResponse);
    });

    it("should handle partial updates", async () => {
      const id = "repo-1";
      const request: UpdateRepositoryRequest = {
        default_sandbox_type: "git_worktree",
      };

      const mockResponse: ConfiguredRepository = {
        id: "repo-1",
        repository_url: "https://github.com/test/repo",
        display_name: "test/repo",
        owner: "test",
        default_branch: "main",
        is_verified: true,
        last_verified_at: "2024-01-01T00:00:00Z",
        default_sandbox_type: "git_worktree",
        default_commands: ["create-branch", "planning", "execute", "commit", "create-pr"],
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      };

      vi.mocked(callAPIWithETag).mockResolvedValue(mockResponse);

      const result = await repositoryService.updateRepository(id, request);

      expect(result.default_sandbox_type).toBe("git_worktree");
    });

    it("should handle not found errors", async () => {
      const error = new Error("Repository not found");
      vi.mocked(callAPIWithETag).mockRejectedValue(error);

      await expect(
        repositoryService.updateRepository("non-existent", {
          default_sandbox_type: "git_branch",
        }),
      ).rejects.toThrow("Repository not found");
    });
  });

  describe("deleteRepository", () => {
    it("should call DELETE /api/agent-work-orders/repositories/:id", async () => {
      const id = "repo-1";
      vi.mocked(callAPIWithETag).mockResolvedValue(undefined);

      await repositoryService.deleteRepository(id);

      expect(callAPIWithETag).toHaveBeenCalledWith(`/api/agent-work-orders/repositories/${id}`, {
        method: "DELETE",
      });
    });

    it("should handle not found errors", async () => {
      const error = new Error("Repository not found");
      vi.mocked(callAPIWithETag).mockRejectedValue(error);

      await expect(repositoryService.deleteRepository("non-existent")).rejects.toThrow("Repository not found");
    });
  });

  describe("verifyRepositoryAccess", () => {
    it("should call POST /api/agent-work-orders/repositories/:id/verify", async () => {
      const id = "repo-1";
      const mockResponse = {
        is_accessible: true,
        repository_id: "repo-1",
      };

      vi.mocked(callAPIWithETag).mockResolvedValue(mockResponse);

      const result = await repositoryService.verifyRepositoryAccess(id);

      expect(callAPIWithETag).toHaveBeenCalledWith(`/api/agent-work-orders/repositories/${id}/verify`, {
        method: "POST",
      });
      expect(result).toEqual(mockResponse);
    });

    it("should handle inaccessible repositories", async () => {
      const id = "repo-1";
      const mockResponse = {
        is_accessible: false,
        repository_id: "repo-1",
      };

      vi.mocked(callAPIWithETag).mockResolvedValue(mockResponse);

      const result = await repositoryService.verifyRepositoryAccess(id);

      expect(result.is_accessible).toBe(false);
    });

    it("should handle verification errors", async () => {
      const error = new Error("GitHub API error");
      vi.mocked(callAPIWithETag).mockRejectedValue(error);

      await expect(repositoryService.verifyRepositoryAccess("repo-1")).rejects.toThrow("GitHub API error");
    });
  });
});
