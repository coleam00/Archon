/**
 * Progress Query Hooks
 * Handles polling for operation progress with TanStack Query
 */

import { type UseQueryResult, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { APIServiceError } from "../../shared/errors";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "../../shared/queryPatterns";
import { useSmartPolling } from "../../ui/hooks";
import { progressService } from "../services";
import type { ActiveOperationsResponse, ProgressResponse, ProgressStatus } from "../types";

// Query keys factory
export const progressKeys = {
  all: ["progress"] as const,
  lists: () => [...progressKeys.all, "list"] as const,
  detail: (id: string) => [...progressKeys.all, "detail", id] as const,
  active: () => [...progressKeys.all, "active"] as const,
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
  const { refetchInterval: smartInterval } = useSmartPolling(options?.pollingInterval ?? 1000);

  // Reset refs when progressId changes
  useEffect(() => {
    hasCalledComplete.current = false;
    hasCalledError.current = false;
    consecutiveNotFound.current = 0;
  }, [progressId]);

  const query = useQuery<ProgressResponse | null>({
    queryKey: progressId ? progressKeys.detail(progressId) : DISABLED_QUERY_KEY,
    queryFn: async () => {
      if (!progressId) throw new Error("No progress ID");

      try {
        const data = await progressService.getProgress(progressId);
        consecutiveNotFound.current = 0; // Reset counter on success
        return data;
      } catch (error: unknown) {
        // Handle 404 errors specially - check status code first, then message as fallback
        const isNotFound =
          (error instanceof APIServiceError && error.statusCode === 404) ||
          (error as { status?: number })?.status === 404 ||
          (error as { response?: { status?: number } })?.response?.status === 404 ||
          (error instanceof Error && /not found/i.test(error.message));

        if (isNotFound) {
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
      const data = query.state.data as ProgressResponse | null | undefined;

      // Only stop polling when we have actual data and it's in a terminal state
      if (data && TERMINAL_STATES.includes(data.status)) {
        return false;
      }

      // Keep polling on undefined (initial), null (transient 404), or active operations
      // Use smart interval that pauses when tab is hidden
      return smartInterval;
    },
    retry: false, // Don't retry on error
    staleTime: STALE_TIMES.instant, // Always fresh for real-time progress
  });

  // Handle completion and error callbacks
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (!query.data) return;

    const status = query.data.status;

    // Handle completion
    if (status === "completed" && !hasCalledComplete.current) {
      hasCalledComplete.current = true;
      options?.onComplete?.(query.data);

      // Clean up the query after completion
      timers.push(
        setTimeout(() => {
          if (progressId) {
            queryClient.removeQueries({ queryKey: progressKeys.detail(progressId), exact: true });
          }
        }, 2000),
      );
    }

    // Handle cancellation
    if (status === "cancelled" && !hasCalledError.current) {
      hasCalledError.current = true;
      options?.onError?.(query.data.error || "Operation was cancelled");

      // Clean up the query after cancellation
      timers.push(
        setTimeout(() => {
          if (progressId) {
            queryClient.removeQueries({ queryKey: progressKeys.detail(progressId), exact: true });
          }
        }, 2000),
      );
    }

    // Handle errors
    if ((status === "error" || status === "failed") && !hasCalledError.current) {
      hasCalledError.current = true;
      options?.onError?.(query.data.error || "Operation failed");

      // Clean up the query after error
      timers.push(
        setTimeout(() => {
          if (progressId) {
            queryClient.removeQueries({ queryKey: progressKeys.detail(progressId), exact: true });
          }
        }, 5000),
      );
    }

    // Cleanup function to clear all timeouts
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [query.data?.status, progressId, queryClient, options, query.data]);

  // Forward query errors (e.g., "Operation no longer exists") to onError callback
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (!query.error || hasCalledError.current) return;

    hasCalledError.current = true;
    const errorMessage = query.error instanceof Error ? query.error.message : String(query.error);
    options?.onError?.(errorMessage);

    // Clean up the query after error
    timers.push(
      setTimeout(() => {
        if (progressId) {
          queryClient.removeQueries({ queryKey: progressKeys.detail(progressId), exact: true });
        }
      }, 5000),
    );

    // Cleanup function to clear timeouts
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [query.error, progressId, queryClient, options]);

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
  const { refetchInterval } = useSmartPolling(5000);

  return useQuery<ActiveOperationsResponse>({
    queryKey: progressKeys.active(),
    queryFn: () => progressService.listActiveOperations(),
    enabled,
    refetchInterval: enabled ? refetchInterval : false, // Only poll when explicitly enabled, pause when hidden
    staleTime: STALE_TIMES.realtime, // Near real-time for active operations
  });
}

/**
 * Hook for polling all crawl operations
 * Used in the CrawlingProgress component
 * Delegates to useActiveOperations for consistency
 */
export function useCrawlProgressPolling() {
  const { data, isLoading } = useActiveOperations(true); // Always enabled for crawling progress

  return {
    activeOperations: data?.operations || [],
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
  // Track consecutive 404s per operation
  const notFoundCounts = useRef<Map<string, number>>(new Map());
  const { refetchInterval: smartInterval } = useSmartPolling(1000);

  // Reset tracking sets when progress IDs change
  // Use sorted JSON stringification for stable dependency that handles reordering
  const progressIdsKey = useMemo(() => JSON.stringify([...progressIds].sort()), [progressIds]);
  useEffect(() => {
    completedIds.current.clear();
    errorIds.current.clear();
    notFoundCounts.current.clear();
  }, [progressIdsKey]); // Stable dependency across reorderings

  const queries = useQueries({
    queries: progressIds.map((progressId) => ({
      queryKey: progressKeys.detail(progressId),
      queryFn: async (): Promise<ProgressResponse | null> => {
        try {
          const data = await progressService.getProgress(progressId);
          notFoundCounts.current.set(progressId, 0); // Reset counter on success
          return data;
        } catch (error: unknown) {
          // Handle 404 errors specially for resilience - check status code first
          const isNotFound =
            (error instanceof APIServiceError && error.statusCode === 404) ||
            (error as { status?: number })?.status === 404 ||
            (error as { response?: { status?: number } })?.response?.status === 404 ||
            (error instanceof Error && /not found/i.test(error.message));

          if (isNotFound) {
            const currentCount = (notFoundCounts.current.get(progressId) || 0) + 1;
            notFoundCounts.current.set(progressId, currentCount);

            // After 5 consecutive 404s, assume the operation is gone
            if (currentCount >= 5) {
              throw new Error("Operation no longer exists");
            }

            // Return null to keep polling a bit longer
            return null;
          }

          throw error;
        }
      },
      refetchInterval: (query: { state: { data: ProgressResponse | null | undefined } }) => {
        const data = query.state.data;

        // Only stop polling when we have actual data and it's in a terminal state
        if (data && TERMINAL_STATES.includes(data.status)) {
          return false;
        }

        // Keep polling on undefined (initial), null (transient 404), or active operations
        // Use smart interval that pauses when tab is hidden
        return smartInterval;
      },
      retry: false,
      staleTime: STALE_TIMES.instant, // Always fresh for real-time progress
    })),
  }) as UseQueryResult<ProgressResponse | null, Error>[];

  // Handle callbacks for each operation
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    queries.forEach((query, index) => {
      const progressId = progressIds[index];
      if (!query.data || !progressId) return;

      const data = query.data as ProgressResponse | null;
      if (!data) return;

      const status = data.status;

      // Handle completion
      if (status === "completed" && !completedIds.current.has(progressId)) {
        completedIds.current.add(progressId);
        options?.onComplete?.(progressId, data);

        // Clean up after completion
        timers.push(
          setTimeout(() => {
            queryClient.removeQueries({ queryKey: progressKeys.detail(progressId), exact: true });
          }, 2000),
        );
      }

      // Handle errors
      if ((status === "error" || status === "failed") && !errorIds.current.has(progressId)) {
        errorIds.current.add(progressId);
        options?.onError?.(progressId, data.error || "Operation failed");

        // Clean up after error
        timers.push(
          setTimeout(() => {
            queryClient.removeQueries({ queryKey: progressKeys.detail(progressId), exact: true });
          }, 5000),
        );
      }
    });

    // Cleanup function to clear all timeouts
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [queries, progressIds, queryClient, options]);

  // Forward query errors (e.g., 404s after threshold) to onError callback
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    queries.forEach((query, index) => {
      const progressId = progressIds[index];
      if (!query.error || !progressId || errorIds.current.has(progressId)) return;

      errorIds.current.add(progressId);
      const errorMessage = query.error instanceof Error ? query.error.message : String(query.error);
      options?.onError?.(progressId, errorMessage);

      // Clean up after error
      timers.push(
        setTimeout(() => {
          queryClient.removeQueries({ queryKey: progressKeys.detail(progressId), exact: true });
        }, 5000),
      );
    });

    // Cleanup function to clear all timeouts
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [queries, progressIds, queryClient, options]);

  return queries.map((query, index) => {
    const data = query.data as ProgressResponse | null;
    return {
      progressId: progressIds[index],
      data,
      isLoading: query.isLoading,
      error: query.error,
      isComplete: data?.status === "completed",
      isFailed: data?.status === "error" || data?.status === "failed",
      isActive: data ? !TERMINAL_STATES.includes(data.status) : false,
    };
  });
}
