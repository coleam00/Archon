/**
 * Workflow Template Query Hooks
 *
 * TanStack Query hooks for workflow template CRUD operations.
 * Handles server state management for workflow templates.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "@/features/shared/config/queryPatterns";
import { workflowService } from "../services";
import type { CreateWorkflowTemplateRequest, UpdateWorkflowTemplateRequest, WorkflowTemplate } from "../types";

/**
 * Query key factory for workflow templates
 */
export const workflowKeys = {
  all: ["context-hub", "workflows"] as const,
  lists: () => [...workflowKeys.all, "list"] as const,
  detail: (slug: string) => [...workflowKeys.all, "detail", slug] as const,
};

/**
 * List all workflow templates
 */
export function useWorkflowTemplates(isActive?: boolean) {
  return useQuery({
    queryKey: [...workflowKeys.lists(), { isActive }],
    queryFn: () => workflowService.listWorkflowTemplates(isActive),
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Get workflow template by slug
 */
export function useWorkflowTemplate(slug: string | undefined) {
  return useQuery({
    queryKey: slug ? workflowKeys.detail(slug) : DISABLED_QUERY_KEY,
    queryFn: () => {
      if (!slug) throw new Error("Slug is required");
      return workflowService.getWorkflowTemplate(slug);
    },
    enabled: !!slug,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Create new workflow template
 */
export function useCreateWorkflowTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateWorkflowTemplateRequest) => workflowService.createWorkflowTemplate(data),
    onSuccess: () => {
      // Invalidate lists to refetch with new template
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
  });
}

/**
 * Update workflow template
 */
export function useUpdateWorkflowTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ slug, updates }: { slug: string; updates: UpdateWorkflowTemplateRequest }) =>
      workflowService.updateWorkflowTemplate(slug, updates),
    onSuccess: (updatedTemplate) => {
      // Invalidate lists
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
      // Invalidate detail for this slug
      queryClient.invalidateQueries({ queryKey: workflowKeys.detail(updatedTemplate.slug) });
    },
  });
}
