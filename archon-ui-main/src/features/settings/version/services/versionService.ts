/**
 * Service for version checking and update management
 */

import { callAPIWithETag } from "@/features/shared/apiWithEtag";
import type { CurrentVersionResponse, VersionCheckResponse } from "../types";

export const versionService = {
  /**
   * Check for available Archon updates
   */
  async checkVersion(): Promise<VersionCheckResponse> {
    try {
      const response = await callAPIWithETag("/api/version/check");
      return response as VersionCheckResponse;
    } catch (error) {
      console.error("Error checking version:", error);
      throw error;
    }
  },

  /**
   * Get current Archon version without checking for updates
   */
  async getCurrentVersion(): Promise<CurrentVersionResponse> {
    try {
      const response = await callAPIWithETag("/api/version/current");
      return response as CurrentVersionResponse;
    } catch (error) {
      console.error("Error getting current version:", error);
      throw error;
    }
  },

  /**
   * Clear version cache to force fresh check
   */
  async clearCache(): Promise<{ message: string; success: boolean }> {
    try {
      const response = await callAPIWithETag("/api/version/clear-cache", {
        method: "POST",
      });
      return response as { message: string; success: boolean };
    } catch (error) {
      console.error("Error clearing version cache:", error);
      throw error;
    }
  },
};
