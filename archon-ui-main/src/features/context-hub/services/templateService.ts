/**
 * Agent Template Service
 *
 * API client for agent template CRUD operations.
 * Calls main server endpoints (port 8181), NOT AWO service (port 8053).
 */

import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type { AgentTemplate, CreateAgentTemplateRequest, UpdateAgentTemplateRequest } from "../types";

/**
 * List all agent templates
 *
 * @param isActive - Filter by active status (undefined = all)
 * @param latestOnly - Only return latest version of each slug
 */
async function listAgentTemplates(isActive?: boolean, latestOnly: boolean = true): Promise<AgentTemplate[]> {
  const params = new URLSearchParams();
  if (isActive !== undefined) {
    params.append("is_active", String(isActive));
  }
  params.append("latest_only", String(latestOnly));

  const queryString = params.toString();
  const endpoint = `/api/templates/agents/${queryString ? `?${queryString}` : ""}`;

  console.log('[TEMPLATE SERVICE] Calling endpoint:', endpoint);
  console.log('[TEMPLATE SERVICE] Query params:', { isActive, latestOnly });

  const result = await callAPIWithETag<AgentTemplate[]>(endpoint);
  console.log('[TEMPLATE SERVICE] Got result:', result?.length, 'templates');
  return result;
}

/**
 * Get agent template by slug
 *
 * @param slug - Template slug
 * @param version - Specific version (undefined = latest)
 */
async function getAgentTemplate(slug: string, version?: number): Promise<AgentTemplate> {
  const params = new URLSearchParams();
  if (version !== undefined) {
    params.append("version", String(version));
  }

  const queryString = params.toString();
  const endpoint = `/api/templates/agents/${slug}${queryString ? `?${queryString}` : ""}`;

  return callAPIWithETag<AgentTemplate>(endpoint);
}

/**
 * Create new agent template
 */
async function createAgentTemplate(data: CreateAgentTemplateRequest): Promise<AgentTemplate> {
  return callAPIWithETag<AgentTemplate>("/api/templates/agents/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/**
 * Update agent template (creates new version)
 */
async function updateAgentTemplate(slug: string, updates: UpdateAgentTemplateRequest): Promise<AgentTemplate> {
  return callAPIWithETag<AgentTemplate>(`/api/templates/agents/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

/**
 * Get all versions of a template
 */
async function getTemplateVersions(slug: string): Promise<AgentTemplate[]> {
  return callAPIWithETag<AgentTemplate[]>(`/api/templates/agents/${slug}/versions`);
}

/**
 * Agent template service object
 */
export const templateService = {
  listAgentTemplates,
  getAgentTemplate,
  createAgentTemplate,
  updateAgentTemplate,
  getTemplateVersions,
};
