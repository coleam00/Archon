/**
 * Repository Query Hooks Tests
 *
 * Unit tests for repository query hooks.
 * Mocks repositoryService and query patterns.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfiguredRepository, CreateRepositoryRequest, UpdateRepositoryRequest } from "../../types/repository";
import {
  repositoryKeys,
  useCreateRepository,
  useDeleteRepository,
  useRepositories,
  useUpdateRepository,
  useVerifyRepository,
} from "../useRepositoryQueries";

// Mock the repository service
vi.mock("../../services/repositoryService", () => ({
  repositoryService: {
    listRepositories: vi.fn(),
    createRepository: vi.fn(),
    updateRepository: vi.fn(),
    deleteRepository: vi.fn(),
    verifyRepositoryAccess: vi.fn(),
  },
}));

// Mock shared patterns
vi.mock("@/features/shared/config/queryPatterns", () => ({
  DISABLED_QUERY_KEY: ["disabled"] as const,
  STALE_TIMES: {
    instant: 0,
    realtime: 3000,
    frequent: 5000,
    normal: 30000,
    rare: 300000,
    static: Number.POSITIVE_INFINITY,
  },
}));

// Mock toast hook
vi.mock("@/features/ui/hooks/useToast", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

// Import after mocking
import { repositoryService } from "../../services/repositoryService";

describe("useRepositoryQueries", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    // Create fresh query client for each test
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  const createWrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  describe("repositoryKeys", () => {
    it("should generate correct query keys", () => {
      expect(repositoryKeys.all).toEqual(["repositories"]);
      expect(repositoryKeys.lists()).toEqual(["repositories", "list"]);
      expect(repositoryKeys.detail("repo-1")).toEqual(["repositories", "detail", "repo-1"]);
    });
  });

  describe("useRepositories", () => {
    it("should fetch repositories list", async () => {
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

      vi.mocked(repositoryService.listRepositories).mockResolvedValue(mockRepositories);

      const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(mockRepositories);
      expect(repositoryService.listRepositories).toHaveBeenCalledOnce();
    });

    it("should handle empty repository list", async () => {
      vi.mocked(repositoryService.listRepositories).mockResolvedValue([]);

      const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual([]);
    });

    it("should handle errors", async () => {
      const error = new Error("Network error");
      vi.mocked(repositoryService.listRepositories).mockRejectedValue(error);

      const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toEqual(error);
    });
  });

  describe("useCreateRepository", () => {
    it("should create repository with optimistic update", async () => {
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

      vi.mocked(repositoryService.createRepository).mockResolvedValue(mockResponse);

      const { result } = renderHook(() => useCreateRepository(), { wrapper: createWrapper });

      await act(async () => {
        await result.current.mutateAsync(request);
      });

      expect(repositoryService.createRepository).toHaveBeenCalledWith(request);
    });

    it("should rollback on error", async () => {
      const request: CreateRepositoryRequest = {
        repository_url: "https://github.com/test/repo",
      };

      const error = new Error("Creation failed");
      vi.mocked(repositoryService.createRepository).mockRejectedValue(error);

      // Set initial data
      queryClient.setQueryData(repositoryKeys.lists(), []);

      const { result } = renderHook(() => useCreateRepository(), { wrapper: createWrapper });

      await act(async () => {
        try {
          await result.current.mutateAsync(request);
        } catch {
          // Expected error
        }
      });

      // Should rollback to empty array
      const data = queryClient.getQueryData(repositoryKeys.lists());
      expect(data).toEqual([]);
    });
  });

  describe("useUpdateRepository", () => {
    it("should update repository with optimistic update", async () => {
      const id = "repo-1";
      const request: UpdateRepositoryRequest = {
        default_sandbox_type: "git_branch",
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

      vi.mocked(repositoryService.updateRepository).mockResolvedValue(mockResponse);

      const { result } = renderHook(() => useUpdateRepository(), { wrapper: createWrapper });

      await act(async () => {
        await result.current.mutateAsync({ id, request });
      });

      expect(repositoryService.updateRepository).toHaveBeenCalledWith(id, request);
    });

    it("should rollback on error", async () => {
      const initialRepo: ConfiguredRepository = {
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
      };

      // Set initial data
      queryClient.setQueryData(repositoryKeys.lists(), [initialRepo]);

      const error = new Error("Update failed");
      vi.mocked(repositoryService.updateRepository).mockRejectedValue(error);

      const { result } = renderHook(() => useUpdateRepository(), { wrapper: createWrapper });

      await act(async () => {
        try {
          await result.current.mutateAsync({
            id: "repo-1",
            request: { default_sandbox_type: "git_branch" },
          });
        } catch {
          // Expected error
        }
      });

      // Should rollback to initial data
      const data = queryClient.getQueryData(repositoryKeys.lists());
      expect(data).toEqual([initialRepo]);
    });
  });

  describe("useDeleteRepository", () => {
    it("should delete repository with optimistic removal", async () => {
      const initialRepo: ConfiguredRepository = {
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
      };

      // Set initial data
      queryClient.setQueryData(repositoryKeys.lists(), [initialRepo]);

      vi.mocked(repositoryService.deleteRepository).mockResolvedValue();

      const { result } = renderHook(() => useDeleteRepository(), { wrapper: createWrapper });

      await act(async () => {
        await result.current.mutateAsync("repo-1");
      });

      expect(repositoryService.deleteRepository).toHaveBeenCalledWith("repo-1");
    });

    it("should rollback on error", async () => {
      const initialRepo: ConfiguredRepository = {
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
      };

      // Set initial data
      queryClient.setQueryData(repositoryKeys.lists(), [initialRepo]);

      const error = new Error("Delete failed");
      vi.mocked(repositoryService.deleteRepository).mockRejectedValue(error);

      const { result } = renderHook(() => useDeleteRepository(), { wrapper: createWrapper });

      await act(async () => {
        try {
          await result.current.mutateAsync("repo-1");
        } catch {
          // Expected error
        }
      });

      // Should rollback to initial data
      const data = queryClient.getQueryData(repositoryKeys.lists());
      expect(data).toEqual([initialRepo]);
    });
  });

  describe("useVerifyRepository", () => {
    it("should verify repository and invalidate queries", async () => {
      const mockResponse = {
        is_accessible: true,
        repository_id: "repo-1",
      };

      vi.mocked(repositoryService.verifyRepositoryAccess).mockResolvedValue(mockResponse);

      const { result } = renderHook(() => useVerifyRepository(), { wrapper: createWrapper });

      await act(async () => {
        await result.current.mutateAsync("repo-1");
      });

      expect(repositoryService.verifyRepositoryAccess).toHaveBeenCalledWith("repo-1");
    });

    it("should handle inaccessible repository", async () => {
      const mockResponse = {
        is_accessible: false,
        repository_id: "repo-1",
      };

      vi.mocked(repositoryService.verifyRepositoryAccess).mockResolvedValue(mockResponse);

      const { result } = renderHook(() => useVerifyRepository(), { wrapper: createWrapper });

      await act(async () => {
        await result.current.mutateAsync("repo-1");
      });

      expect(result.current.data).toEqual(mockResponse);
    });

    it("should handle verification errors", async () => {
      const error = new Error("GitHub API error");
      vi.mocked(repositoryService.verifyRepositoryAccess).mockRejectedValue(error);

      const { result } = renderHook(() => useVerifyRepository(), { wrapper: createWrapper });

      await act(async () => {
        try {
          await result.current.mutateAsync("repo-1");
        } catch {
          // Expected error
        }
      });

      expect(result.current.isError).toBe(true);
    });
  });
});
