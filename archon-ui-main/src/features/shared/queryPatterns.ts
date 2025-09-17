/**
 * Shared Query Patterns
 *
 * Consistent patterns for TanStack Query across all features
 *
 * USAGE GUIDELINES:
 * - Always use DISABLED_QUERY_KEY for disabled queries
 * - Always use STALE_TIMES constants for staleTime configuration
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
