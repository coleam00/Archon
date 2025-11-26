/**
 * Progress Service for polling operation status
 * Uses ETag support for efficient polling
 */

import { callAPIWithETag } from "../../shared/api/apiClient";
import type { ActiveOperationsResponse, FailedOperationsResponse, ProgressResponse } from "../types";

export const progressService = {
  /**
   * Get progress for an operation
   */
  async getProgress(progressId: string): Promise<ProgressResponse> {
    return callAPIWithETag<ProgressResponse>(`/api/progress/${progressId}`);
  },

  /**
   * List all active operations
   */
  async listActiveOperations(): Promise<ActiveOperationsResponse> {
    // IMPORTANT: Use trailing slash to avoid FastAPI redirect that breaks in Docker
    return callAPIWithETag<ActiveOperationsResponse>("/api/progress/");
  },

  /**
   * List all failed operations
   * These are operations with error/failed status that persist for 5 minutes
   */
  async listFailedOperations(): Promise<FailedOperationsResponse> {
    // Request all operations including failed ones
    const response = await callAPIWithETag<FailedOperationsResponse>(
      "/api/progress/?include_failed=true"
    );

    // Filter to only return operations with error or failed status
    const failedOperations = response.operations.filter(
      (op) => op.status === "error" || op.status === "failed"
    );

    return {
      operations: failedOperations,
      count: failedOperations.length,
      timestamp: response.timestamp,
    };
  },
};
