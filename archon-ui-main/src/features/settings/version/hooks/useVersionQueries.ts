/**
 * TanStack Query hooks for version checking
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { STALE_TIMES } from "@/features/shared/config/queryPatterns";
import { useSmartPolling } from "@/features/shared/hooks/useSmartPolling";
import { versionService } from "../services/versionService";
import type { VersionCheckResponse } from "../types";

// Query key factory
export const versionKeys = {
  all: ["version"] as const,
  check: () => [...versionKeys.all, "check"] as const,
  current: () => [...versionKeys.all, "current"] as const,
};

/**
 * Hook to check for version updates
 * Polls every 5 minutes when tab is visible
 */
export function useVersionCheck() {
  // Smart polling: check every 5 minutes when tab is visible
  const { refetchInterval } = useSmartPolling(300000); // 5 minutes

  return useQuery<VersionCheckResponse>({
    queryKey: versionKeys.check(),
    queryFn: () => versionService.checkVersion(),
    staleTime: STALE_TIMES.rare, // 5 minutes
    refetchInterval,
    retry: false, // Don't retry on 404 or network errors
  });
}

/**
 * Hook to get current version without checking for updates
 */
export function useCurrentVersion() {
  return useQuery({
    queryKey: versionKeys.current(),
    queryFn: () => versionService.getCurrentVersion(),
    staleTime: STALE_TIMES.static, // Never stale
  });
}

/**
 * Hook to clear version cache and force fresh check
 */
export function useClearVersionCache() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => versionService.clearCache(),
    onSuccess: () => {
      // Invalidate version queries to force fresh check
      queryClient.invalidateQueries({ queryKey: versionKeys.all });
    },
  });
}
