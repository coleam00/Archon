/**
 * TanStack Query hooks for migration tracking
 */

import { useQuery } from "@tanstack/react-query";
import { STALE_TIMES } from "@/features/shared/queryPatterns";
import { useSmartPolling } from "@/features/shared/hooks/useSmartPolling";
import { migrationService } from "../services/migrationService";
import type { MigrationHistoryResponse, MigrationStatusResponse, PendingMigration } from "../types";

// Query key factory
export const migrationKeys = {
  all: ["migrations"] as const,
  status: () => [...migrationKeys.all, "status"] as const,
  history: () => [...migrationKeys.all, "history"] as const,
  pending: () => [...migrationKeys.all, "pending"] as const,
};

/**
 * Hook to get comprehensive migration status
 * Polls more frequently when migrations are pending
 */
export function useMigrationStatus() {
  // Poll every 30 seconds when tab is visible
  const { refetchInterval } = useSmartPolling(30000);

  return useQuery<MigrationStatusResponse>({
    queryKey: migrationKeys.status(),
    queryFn: () => migrationService.getMigrationStatus(),
    staleTime: STALE_TIMES.normal, // 30 seconds
    refetchInterval,
  });
}

/**
 * Hook to get migration history
 */
export function useMigrationHistory() {
  return useQuery<MigrationHistoryResponse>({
    queryKey: migrationKeys.history(),
    queryFn: () => migrationService.getMigrationHistory(),
    staleTime: STALE_TIMES.rare, // 5 minutes - history doesn't change often
  });
}

/**
 * Hook to get pending migrations only
 */
export function usePendingMigrations() {
  const { refetchInterval } = useSmartPolling(30000);

  return useQuery<PendingMigration[]>({
    queryKey: migrationKeys.pending(),
    queryFn: () => migrationService.getPendingMigrations(),
    staleTime: STALE_TIMES.normal,
    refetchInterval,
  });
}
