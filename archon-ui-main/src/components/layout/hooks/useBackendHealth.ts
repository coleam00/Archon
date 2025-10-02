import { useQuery } from "@tanstack/react-query";
import { callAPIWithETag } from "../../../features/shared/api/apiClient";
import { createRetryLogic, STALE_TIMES } from "../../../features/shared/config/queryPatterns";
import type { HealthResponse } from "../types";

/**
 * Hook to monitor backend health status using TanStack Query
 * Uses ETag caching for bandwidth reduction (~70% savings per project docs)
 */
export function useBackendHealth() {
  return useQuery<HealthResponse>({
    queryKey: ["backend", "health"],
    queryFn: ({ signal }) => {
      // Use existing ETag infrastructure with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      // Chain signals: React Query's signal + our timeout
      if (signal) {
        signal.addEventListener("abort", () => controller.abort());
      }

      return callAPIWithETag<HealthResponse>("/api/health", {
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timeoutId);
      });
    },
    // Retry configuration for startup scenarios - respect 4xx but allow more attempts
    retry: createRetryLogic(5),
    retryDelay: (attemptIndex) => {
      // Exponential backoff: 1.5s, 2.25s, 3.375s, etc.
      return Math.min(1500 * 1.5 ** attemptIndex, 10000);
    },
    // Refetch every 30 seconds when healthy
    refetchInterval: STALE_TIMES.normal,
    // Keep trying to connect on window focus
    refetchOnWindowFocus: true,
    // Consider data fresh for 30 seconds
    staleTime: STALE_TIMES.normal,
  });
}
