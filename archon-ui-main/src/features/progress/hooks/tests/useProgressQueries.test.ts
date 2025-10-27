import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveOperationsResponse, ProgressResponse } from "../../types";
import {
  progressKeys,
  useActiveOperations,
  useCrawlProgressPolling,
  useOperationProgress,
} from "../useProgressQueries";

// Mock the services
vi.mock("../../services", () => ({
  progressService: {
    getProgress: vi.fn(),
    listActiveOperations: vi.fn(),
  },
}));

// Mock shared query patterns
vi.mock("../../../shared/config/queryPatterns", () => ({
  DISABLED_QUERY_KEY: ["disabled"] as const,
  STALE_TIMES: {
    instant: 0,
    realtime: 3_000,
    frequent: 5_000,
    normal: 30_000,
    rare: 300_000,
    static: Infinity,
  },
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

describe("useProgressQueries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("progressKeys", () => {
    it("should generate correct query keys", () => {
      expect(progressKeys.all).toEqual(["progress"]);
      expect(progressKeys.lists()).toEqual(["progress", "list"]);
      expect(progressKeys.detail("progress-123")).toEqual(["progress", "detail", "progress-123"]);
      expect(progressKeys.active()).toEqual(["progress", "active"]);
    });
  });

  describe("useOperationProgress", () => {
    it("should poll for progress when progressId is provided", async () => {
      const mockProgress: ProgressResponse = {
        progressId: "progress-123",
        status: "processing",
        message: "Processing...",
        progress: 50,
        details: {},
      };

      const { progressService } = await import("../../services");
      vi.mocked(progressService.getProgress).mockResolvedValue(mockProgress);

      const { result } = renderHook(() => useOperationProgress("progress-123"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.data).toEqual(mockProgress);
        expect(progressService.getProgress).toHaveBeenCalledWith("progress-123");
      });
    });

    it("should call onComplete callback when operation completes", async () => {
      const onComplete = vi.fn();
      const completedProgress: ProgressResponse = {
        progressId: "progress-123",
        status: "completed",
        message: "Completed",
        progress: 100,
        details: { result: "success" },
      };

      const { progressService } = await import("../../services");
      vi.mocked(progressService.getProgress).mockResolvedValue(completedProgress);

      const { result } = renderHook(() => useOperationProgress("progress-123", { onComplete }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.data?.status).toBe("completed");
        expect(onComplete).toHaveBeenCalledWith(completedProgress);
      });
    });

    it("should call onError callback when operation fails", async () => {
      const onError = vi.fn();
      const errorProgress: ProgressResponse = {
        progressId: "progress-123",
        status: "error",
        message: "Failed to process",
        progress: 0,
        error: "Something went wrong",
      };

      const { progressService } = await import("../../services");
      vi.mocked(progressService.getProgress).mockResolvedValue(errorProgress);

      const { result } = renderHook(() => useOperationProgress("progress-123", { onError }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.data?.status).toBe("error");
        // onError is called with just the error string, not the full response
        expect(onError).toHaveBeenCalledWith("Something went wrong");
      });
    });

    it("should not execute query when progressId is null", () => {
      const { result } = renderHook(() => useOperationProgress(null), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toBeUndefined();
    });
  });

  describe("useActiveOperations", () => {
    it("should fetch active operations when enabled", async () => {
      const mockOperations: ActiveOperationsResponse = {
        operations: [
          {
            progressId: "op-1",
            sourceId: "source-1",
            status: "processing",
            message: "Processing document",
            progress: 30,
          },
          {
            progressId: "op-2",
            sourceId: "source-2",
            status: "processing",
            message: "Crawling website",
            progress: 60,
          },
        ],
      };

      const { progressService } = await import("../../services");
      vi.mocked(progressService.listActiveOperations).mockResolvedValue(mockOperations);

      const { result } = renderHook(() => useActiveOperations(true), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
        expect(result.current.data).toEqual(mockOperations);
        expect(progressService.listActiveOperations).toHaveBeenCalled();
      });
    });

    it("should not fetch when disabled", () => {
      const { result } = renderHook(() => useActiveOperations(false), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.isFetching).toBe(false);
      expect(result.current.data).toBeUndefined();
    });
  });

  describe("useCrawlProgressPolling", () => {
    it("should poll for active crawl operations", async () => {
      const mockOperations: ActiveOperationsResponse = {
        operations: [
          {
            progressId: "crawl-1",
            sourceId: "source-1",
            status: "processing",
            message: "Crawling page 1 of 5",
            progress: 20,
          },
        ],
      };

      const { progressService } = await import("../../services");
      vi.mocked(progressService.listActiveOperations).mockResolvedValue(mockOperations);

      const { result } = renderHook(() => useCrawlProgressPolling(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
        expect(result.current.activeOperations).toEqual(mockOperations.operations);
      });
    });

    it("should return empty array when no operations", async () => {
      const emptyResponse: ActiveOperationsResponse = {
        operations: [],
        count: 0,
      };

      const { progressService } = await import("../../services");
      vi.mocked(progressService.listActiveOperations).mockResolvedValue(emptyResponse);

      const { result } = renderHook(() => useCrawlProgressPolling(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.activeOperations).toEqual([]);
        expect(result.current.totalCount).toBe(0);
      });
    });

    it("should identify active operations correctly", async () => {
      const mockOperations: ActiveOperationsResponse = {
        operations: [
          {
            progressId: "op-1",
            sourceId: "source-1",
            status: "processing",
            message: "Active operation",
            progress: 50,
          },
        ],
        count: 1,
      };

      const { progressService } = await import("../../services");
      vi.mocked(progressService.listActiveOperations).mockResolvedValue(mockOperations);

      const { result } = renderHook(() => useCrawlProgressPolling(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.activeOperations).toHaveLength(1);
        expect(result.current.totalCount).toBe(1);
      });
    });
  });
});
