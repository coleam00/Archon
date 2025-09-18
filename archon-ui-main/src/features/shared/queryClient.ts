import { QueryClient } from "@tanstack/react-query";
import { createRetryLogic, STALE_TIMES } from "./queryPatterns";

/**
 * Centralized QueryClient configuration for the entire application
 *
 * Benefits:
 * - Single source of truth for cache configuration
 * - Automatic request deduplication for same query keys
 * - Smart retry logic that avoids retrying on client errors
 * - Optimized garbage collection and structural sharing
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Default stale time - most data is considered fresh for 30 seconds
      staleTime: STALE_TIMES.normal,

      // Keep unused data in cache for 10 minutes (was 5 minutes)
      gcTime: 10 * 60 * 1000,

      // Smart retry logic - don't retry on 4xx errors or aborts
      retry: createRetryLogic(2),

      // Exponential backoff for retries
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),

      // Disable aggressive refetching to reduce API calls
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: true,

      // Network behavior
      networkMode: "online",

      // Enable structural sharing for efficient re-renders
      structuralSharing: true,
    },

    mutations: {
      // No retries for mutations - let user explicitly retry
      retry: false,

      // Network behavior
      networkMode: "online",
    },
  },
});

/**
 * Create a test QueryClient with optimized settings for tests
 * Used by test-utils.tsx for consistent test behavior
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0, // Always fresh in tests
        gcTime: 0, // No caching in tests
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
