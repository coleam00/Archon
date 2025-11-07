/**
 * Repository Service
 *
 * Service layer for repository CRUD operations.
 * All methods use callAPIWithETag for automatic ETag caching.
 */

import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type {
  ApplyWorkflowTemplateRequest,
  AssignCodingStandardsRequest,
  ConfiguredRepository,
  CreateRepositoryRequest,
  RepositoryAgentOverride,
  UpdatePrimingContextRequest,
  UpdateRepositoryRequest,
  UpsertAgentOverrideRequest,
} from "../types/repository";

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

// Phase 2: Template Linking

/**
 * Apply workflow template to repository, or clear it with null
 * @param repositoryId - Repository ID
 * @param workflowTemplateId - Workflow template UUID from Context Hub, or null to clear
 * @returns The updated repository
 */
export async function applyWorkflowTemplate(
  repositoryId: string,
  workflowTemplateId: string | null
): Promise<ConfiguredRepository> {
  return callAPIWithETag<ConfiguredRepository>(
    `/api/agent-work-orders/repositories/${repositoryId}/workflow-template`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workflow_template_id: workflowTemplateId }),
    },
  );
}

/**
 * Update repository priming context
 * @param repositoryId - Repository ID
 * @param primingContext - Priming context dict (paths, architecture, etc.)
 * @returns The updated repository
 */
export async function updatePrimingContext(
  repositoryId: string,
  primingContext: Record<string, any>
): Promise<ConfiguredRepository> {
  return callAPIWithETag<ConfiguredRepository>(
    `/api/agent-work-orders/repositories/${repositoryId}/priming-context`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(primingContext),
    },
  );
}

/**
 * Assign coding standards to repository
 * @param repositoryId - Repository ID
 * @param codingStandardIds - List of coding standard UUIDs from Context Hub
 * @returns The updated repository
 */
export async function assignCodingStandards(
  repositoryId: string,
  codingStandardIds: string[]
): Promise<ConfiguredRepository> {
  return callAPIWithETag<ConfiguredRepository>(
    `/api/agent-work-orders/repositories/${repositoryId}/coding-standards`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ coding_standard_ids: codingStandardIds }),
    },
  );
}

/**
 * List all agent overrides for a repository
 * @param repositoryId - Repository ID
 * @returns Array of agent overrides
 */
export async function listAgentOverrides(
  repositoryId: string
): Promise<RepositoryAgentOverride[]> {
  return callAPIWithETag<RepositoryAgentOverride[]>(
    `/api/agent-work-orders/repositories/${repositoryId}/agent-overrides`,
    {
      method: "GET",
    },
  );
}

/**
 * Create or update agent override for repository
 * @param repositoryId - Repository ID
 * @param agentTemplateId - Agent template UUID
 * @param request - Override request with tools and/or standards
 * @returns The created or updated agent override
 */
export async function upsertAgentOverride(
  repositoryId: string,
  agentTemplateId: string,
  request: UpsertAgentOverrideRequest
): Promise<RepositoryAgentOverride> {
  return callAPIWithETag<RepositoryAgentOverride>(
    `/api/agent-work-orders/repositories/${repositoryId}/agent-overrides/${agentTemplateId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );
}

/**
 * Delete agent override for repository
 * @param repositoryId - Repository ID
 * @param agentTemplateId - Agent template UUID
 */
export async function deleteAgentOverride(
  repositoryId: string,
  agentTemplateId: string
): Promise<void> {
  await callAPIWithETag<void>(
    `/api/agent-work-orders/repositories/${repositoryId}/agent-overrides/${agentTemplateId}`,
    {
      method: "DELETE",
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
  // Phase 2: Template Linking
  applyWorkflowTemplate,
  updatePrimingContext,
  assignCodingStandards,
  listAgentOverrides,
  upsertAgentOverride,
  deleteAgentOverride,
};

export default repositoryService;
