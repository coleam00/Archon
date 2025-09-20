/**
 * Service for database migration tracking and management
 */

import { callAPIWithETag } from "@/features/shared/apiWithEtag";
import type { MigrationHistoryResponse, MigrationStatusResponse, PendingMigration } from "../types";

export const migrationService = {
  /**
   * Get comprehensive migration status including pending and applied
   */
  async getMigrationStatus(): Promise<MigrationStatusResponse> {
    try {
      const response = await callAPIWithETag("/api/migrations/status");
      return response as MigrationStatusResponse;
    } catch (error) {
      console.error("Error getting migration status:", error);
      throw error;
    }
  },

  /**
   * Get history of applied migrations
   */
  async getMigrationHistory(): Promise<MigrationHistoryResponse> {
    try {
      const response = await callAPIWithETag("/api/migrations/history");
      return response as MigrationHistoryResponse;
    } catch (error) {
      console.error("Error getting migration history:", error);
      throw error;
    }
  },

  /**
   * Get list of pending migrations only
   */
  async getPendingMigrations(): Promise<PendingMigration[]> {
    try {
      const response = await callAPIWithETag("/api/migrations/pending");
      return response as PendingMigration[];
    } catch (error) {
      console.error("Error getting pending migrations:", error);
      throw error;
    }
  },
};
