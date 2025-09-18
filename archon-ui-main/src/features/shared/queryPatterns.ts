/**
 * Shared Query Patterns
 *
 * Consistent patterns for TanStack Query across all features
 *
 * USAGE GUIDELINES:
 * - Always use DISABLED_QUERY_KEY for disabled queries
 * - Always use STALE_TIMES constants for staleTime configuration
 * - Use createRetryLogic() for consistent retry behavior across the app
 * - Never hardcode stale times directly in hooks
 */

// Consistent disabled query key - use when query should not execute
export const DISABLED_QUERY_KEY = ["disabled"] as const;

// Consistent stale times by update frequency
// Use these to ensure predictable caching behavior across the app
export const STALE_TIMES = {
  instant: 0, // Always fresh - for real-time data like active progress
  realtime: 3_000, // 3 seconds - for near real-time updates
  frequent: 5_000, // 5 seconds - for frequently changing data
  normal: 30_000, // 30 seconds - standard cache time for most data
  rare: 300_000, // 5 minutes - for rarely changing configuration
  static: Infinity, // Never stale - for static data like settings
} as const;

// Re-export commonly used TanStack Query types for convenience
export type { QueryKey, QueryOptions } from "@tanstack/react-query";

/**
 * Extract HTTP status code from various error objects
 * Handles different client libraries and error structures
 */
function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const anyErr = error as any;

  // Check common status properties in order of likelihood
  if (typeof anyErr.statusCode === "number") return anyErr.statusCode;  // APIServiceError
  if (typeof anyErr.status === "number") return anyErr.status;          // fetch Response
  if (typeof anyErr.response?.status === "number") return anyErr.response.status; // axios

  return undefined;
}

/**
 * Check if error is an abort/cancel operation that shouldn't be retried
 */
function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const anyErr = error as any;
  return anyErr?.name === "AbortError" || anyErr?.code === "ERR_CANCELED";
}

/**
 * Unified retry logic for TanStack Query
 * - No retries on 4xx client errors (permanent failures)
 * - No retries on abort/cancel operations
 * - Configurable retry count for other errors
 */
export function createRetryLogic(maxRetries: number = 2) {
  return (failureCount: number, error: unknown) => {
    // Don't retry aborted operations
    if (isAbortError(error)) return false;

    // Don't retry 4xx client errors (400-499)
    const status = getErrorStatus(error);
    if (status && status >= 400 && status < 500) return false;

    // Retry up to maxRetries for other errors (5xx, network, etc)
    return failureCount < maxRetries;
  };
}
