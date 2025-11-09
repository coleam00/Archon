/**
 * Repository Service
 *
 * Service layer for repository CRUD operations.
 * All methods use callAPIWithETag for automatic ETag caching.
 */

import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type { ConfiguredRepository, CreateRepositoryRequest, UpdateRepositoryRequest } from "../types/repository";

/**
 * List all configured repositories
 * @returns Array of configured repositories ordered by created_at DESC
 */
export async function listRepositories(): Promise<ConfiguredRepository[]> {
  return callAPIWithETag<ConfiguredRepository[]>("/api/agent-work-orders/repositories", {
    method: "GET",
  });
}

/**
 * Create a new configured repository
 * @param request - Repository creation request with URL and optional verification
 * @returns The created repository with metadata
 */
export async function createRepository(request: CreateRepositoryRequest): Promise<ConfiguredRepository> {
  return callAPIWithETag<ConfiguredRepository>("/api/agent-work-orders/repositories", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
}

/**
 * Update an existing configured repository
 * @param id - Repository ID
 * @param request - Partial update request with fields to modify
 * @returns The updated repository
 */
export async function updateRepository(id: string, request: UpdateRepositoryRequest): Promise<ConfiguredRepository> {
  return callAPIWithETag<ConfiguredRepository>(`/api/agent-work-orders/repositories/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
}

/**
 * Delete a configured repository
 * @param id - Repository ID to delete
 */
export async function deleteRepository(id: string): Promise<void> {
  await callAPIWithETag<void>(`/api/agent-work-orders/repositories/${id}`, {
    method: "DELETE",
  });
}

/**
 * Verify repository access and update metadata
 * Re-verifies GitHub repository access and updates display_name, owner, default_branch
 * @param id - Repository ID to verify
 * @returns Verification result with is_accessible boolean
 */
export async function verifyRepositoryAccess(id: string): Promise<{ is_accessible: boolean; repository_id: string }> {
  return callAPIWithETag<{ is_accessible: boolean; repository_id: string }>(
    `/api/agent-work-orders/repositories/${id}/verify`,
    {
      method: "POST",
    },
  );
}

// Export all methods as named exports and default object
export const repositoryService = {
  listRepositories,
  createRepository,
  updateRepository,
  deleteRepository,
  verifyRepositoryAccess,
};

export default repositoryService;
