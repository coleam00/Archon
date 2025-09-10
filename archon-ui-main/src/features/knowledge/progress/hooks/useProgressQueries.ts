/**
 * Progress Query Hooks
 * Handles polling for operation progress with TanStack Query
 */

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { progressService } from "../services";
import type { ActiveOperationsResponse, ProgressResponse, ProgressStatus } from "../types";

// Query keys factory
export const progressKeys = {
  all: ["progress"] as const,
  detail: (progressId: string) => [...progressKeys.all, progressId] as const,
  list: () => [...progressKeys.all, "list"] as const,
};

// Terminal states that should stop polling
const TERMINAL_STATES: ProgressStatus[] = ["completed", "error", "failed", "cancelled"];

/**
 * Poll for operation progress
 * Automatically stops polling when operation completes or fails
 */
export function useOperationProgress(
  progressId: string | null,
  options?: {
    onComplete?: (data: ProgressResponse) => void;
    onError?: (error: string) => void;
    pollingInterval?: number;
  },
) {
  const queryClient = useQueryClient();
  const hasCalledComplete = useRef(false);
  const hasCalledError = useRef(false);
  const consecutiveNotFound = useRef(0);

  // Reset refs when progressId changes
  useEffect(() => {
    hasCalledComplete.current = false;
    hasCalledError.current = false;
    consecutiveNotFound.current = 0;
  }, [progressId]);

  const query = useQuery<ProgressResponse | null>({
    queryKey: progressId ? progressKeys.detail(progressId) : ["progress-undefined"],
    queryFn: async () => {
      if (!progressId) throw new Error("No progress ID");

      try {
        const data = await progressService.getProgress(progressId);
        consecutiveNotFound.current = 0; // Reset counter on success
        return data;
      } catch (error: unknown) {
        // Handle 404 errors specially
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          consecutiveNotFound.current++;

          // After 5 consecutive 404s, assume the operation is gone
          if (consecutiveNotFound.current >= 5) {
            throw new Error("Operation no longer exists");
          }

          // Return null to keep polling a bit longer
          return null;
        }

        throw error;
      }
    },
    enabled: !!progressId,
    refetchInterval: (query) => {
      // Stop polling if no data or operation is complete
      if (!query.state.data || TERMINAL_STATES.includes(query.state.data.status)) {
        return false;
      }

      // Poll every second for active operations
      return options?.pollingInterval ?? 1000;
    },
    retry: false, // Don't retry on error
    staleTime: 0, // Always refetch
  });

  // Handle completion and error callbacks
  useEffect(() => {
    if (!query.data) return;

    const status = query.data.status;

    // Handle completion
    if (status === "completed" && !hasCalledComplete.current) {
      hasCalledComplete.current = true;
      options?.onComplete?.(query.data);

      // Clean up the query after completion
      setTimeout(() => {
        if (progressId) {
          queryClient.removeQueries({ queryKey: progressKeys.detail(progressId) });
        }
      }, 2000);
    }

    // Handle errors
    if ((status === "error" || status === "failed") && !hasCalledError.current) {
      hasCalledError.current = true;
      options?.onError?.(query.data.error || "Operation failed");

      // Clean up the query after error
      setTimeout(() => {
        if (progressId) {
          queryClient.removeQueries({ queryKey: progressKeys.detail(progressId) });
        }
      }, 5000);
    }
  }, [query.data?.status, progressId, queryClient, options, query.data]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
    isComplete: query.data?.status === "completed",
    isFailed: query.data?.status === "error" || query.data?.status === "failed",
    isActive: query.data ? !TERMINAL_STATES.includes(query.data.status) : false,
  };
}

/**
 * Get all active operations
 * Useful for showing a global progress indicator
 * @param enabled - Whether to enable polling (default: false)
 */
export function useActiveOperations(enabled = false) {
  return useQuery<ActiveOperationsResponse>({
    queryKey: progressKeys.list(),
    queryFn: () => progressService.listActiveOperations(),
    enabled,
    refetchInterval: enabled ? 5000 : false, // Only poll when explicitly enabled
    staleTime: 3000,
  });
}

/**
 * Hook for polling all crawl operations
 * Used in the CrawlingProgress component
 */
export function useCrawlProgressPolling() {
  const { data, isLoading } = useQuery({
    queryKey: progressKeys.list(),
    queryFn: () => progressService.listActiveOperations(),
    refetchInterval: 5000, // Poll every 5 seconds
    staleTime: 0,
  });

  const activeOperations = data?.operations || [];

  return {
    activeOperations,
    isLoading,
    totalCount: data?.count || 0,
  };
}

/**
 * Hook to manage multiple progress operations
 * Useful for the crawling tab that shows multiple operations
 */
export function useMultipleOperations(
  progressIds: string[],
  options?: {
    onComplete?: (progressId: string, data: ProgressResponse) => void;
    onError?: (progressId: string, error: string) => void;
  },
) {
  const queryClient = useQueryClient();
  const completedIds = useRef(new Set<string>());
  const errorIds = useRef(new Set<string>());

  // Reset when IDs change
  useEffect(() => {
    completedIds.current.clear();
    errorIds.current.clear();
  }, []);

  const queries = useQueries({
    queries: progressIds.map((progressId) => ({
      queryKey: progressKeys.detail(progressId),
      queryFn: () => progressService.getProgress(progressId),
      refetchInterval: (query: { state: { data?: ProgressResponse } }) => {
        if (!query.state.data || TERMINAL_STATES.includes(query.state.data.status)) {
          return false;
        }
        return 1000;
      },
      retry: false,
      staleTime: 0,
    })),
  });

  // Handle callbacks for each operation
  useEffect(() => {
    queries.forEach((query, index) => {
      const progressId = progressIds[index];
      if (!query.data || !progressId) return;

      const status = query.data.status;

      // Handle completion
      if (status === "completed" && !completedIds.current.has(progressId)) {
        completedIds.current.add(progressId);
        options?.onComplete?.(progressId, query.data);

        // Clean up after completion
        setTimeout(() => {
          queryClient.removeQueries({ queryKey: progressKeys.detail(progressId) });
        }, 2000);
      }

      // Handle errors
      if ((status === "error" || status === "failed") && !errorIds.current.has(progressId)) {
        errorIds.current.add(progressId);
        options?.onError?.(progressId, query.data.error || "Operation failed");

        // Clean up after error
        setTimeout(() => {
          queryClient.removeQueries({ queryKey: progressKeys.detail(progressId) });
        }, 5000);
      }
    });
  }, [queries, progressIds, queryClient, options]);

  return queries.map((query, index) => ({
    progressId: progressIds[index],
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
    isComplete: query.data?.status === "completed",
    isFailed: query.data?.status === "error" || query.data?.status === "failed",
    isActive: query.data ? !TERMINAL_STATES.includes(query.data.status) : false,
  }));
}
