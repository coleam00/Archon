/**
 * Workflow and Step Template Service
 *
 * API client for workflow and step template CRUD operations.
 * Calls main server endpoints (port 8181), NOT AWO service (port 8053).
 */

import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type {
  CreateStepTemplateRequest,
  CreateWorkflowTemplateRequest,
  StepTemplate,
  StepType,
  UpdateStepTemplateRequest,
  UpdateWorkflowTemplateRequest,
  WorkflowTemplate,
} from "../types";

// =====================================================
// WORKFLOW TEMPLATE OPERATIONS
// =====================================================

/**
 * List all workflow templates
 */
async function listWorkflowTemplates(isActive?: boolean): Promise<WorkflowTemplate[]> {
  const params = new URLSearchParams();
  if (isActive !== undefined) {
    params.append("is_active", String(isActive));
  }

  const queryString = params.toString();
  const endpoint = `/api/templates/workflows${queryString ? `?${queryString}` : ""}`;

  return callAPIWithETag<WorkflowTemplate[]>(endpoint);
}

/**
 * Get workflow template by slug
 */
async function getWorkflowTemplate(slug: string): Promise<WorkflowTemplate> {
  return callAPIWithETag<WorkflowTemplate>(`/api/templates/workflows/${slug}`);
}

/**
 * Create new workflow template
 */
async function createWorkflowTemplate(data: CreateWorkflowTemplateRequest): Promise<WorkflowTemplate> {
  return callAPIWithETag<WorkflowTemplate>("/api/templates/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/**
 * Update workflow template
 */
async function updateWorkflowTemplate(slug: string, updates: UpdateWorkflowTemplateRequest): Promise<WorkflowTemplate> {
  return callAPIWithETag<WorkflowTemplate>(`/api/templates/workflows/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

// =====================================================
// STEP TEMPLATE OPERATIONS
// =====================================================

/**
 * List all step templates
 */
async function listStepTemplates(
  stepType?: StepType,
  isActive?: boolean,
  latestOnly: boolean = true,
): Promise<StepTemplate[]> {
  const params = new URLSearchParams();
  if (stepType) {
    params.append("step_type", stepType);
  }
  if (isActive !== undefined) {
    params.append("is_active", String(isActive));
  }
  params.append("latest_only", String(latestOnly));

  const queryString = params.toString();
  const endpoint = `/api/templates/steps${queryString ? `?${queryString}` : ""}`;

  return callAPIWithETag<StepTemplate[]>(endpoint);
}

/**
 * Get step template by slug
 */
async function getStepTemplate(slug: string, version?: number): Promise<StepTemplate> {
  const params = new URLSearchParams();
  if (version !== undefined) {
    params.append("version", String(version));
  }

  const queryString = params.toString();
  const endpoint = `/api/templates/steps/${slug}${queryString ? `?${queryString}` : ""}`;

  return callAPIWithETag<StepTemplate>(endpoint);
}

/**
 * Create new step template
 */
async function createStepTemplate(data: CreateStepTemplateRequest): Promise<StepTemplate> {
  return callAPIWithETag<StepTemplate>("/api/templates/steps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/**
 * Update step template
 */
async function updateStepTemplate(slug: string, updates: UpdateStepTemplateRequest): Promise<StepTemplate> {
  return callAPIWithETag<StepTemplate>(`/api/templates/steps/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

/**
 * Workflow and step template service object
 */
export const workflowService = {
  listWorkflowTemplates,
  getWorkflowTemplate,
  createWorkflowTemplate,
  updateWorkflowTemplate,
  listStepTemplates,
  getStepTemplate,
  createStepTemplate,
  updateStepTemplate,
};
