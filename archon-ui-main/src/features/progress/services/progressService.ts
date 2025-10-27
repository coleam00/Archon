/**
 * Progress Service for polling operation status
 * Uses ETag support for efficient polling
 */

import { callAPIWithETag } from "../../shared/api/apiClient";
import type { ActiveOperationsResponse, ProgressResponse } from "../types";

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
};
