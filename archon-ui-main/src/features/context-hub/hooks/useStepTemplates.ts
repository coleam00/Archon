/**
 * Step Template Query Hooks
 *
 * TanStack Query hooks for step template CRUD operations.
 * Handles server state management for step templates.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "@/features/shared/config/queryPatterns";
import { workflowService } from "../services";
import type { CreateStepTemplateRequest, StepTemplate, StepType, UpdateStepTemplateRequest } from "../types";

/**
 * Query key factory for step templates
 */
export const stepKeys = {
  all: ["context-hub", "steps"] as const,
  lists: () => [...stepKeys.all, "list"] as const,
  detail: (slug: string) => [...stepKeys.all, "detail", slug] as const,
  versions: (slug: string) => [...stepKeys.all, "versions", slug] as const,
};

/**
 * List all step templates
 */
export function useStepTemplates(stepType?: StepType, isActive?: boolean, latestOnly: boolean = true) {
  return useQuery({
    queryKey: [...stepKeys.lists(), { stepType, isActive, latestOnly }],
    queryFn: () => workflowService.listStepTemplates(stepType, isActive, latestOnly),
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Get step template by slug
 */
export function useStepTemplate(slug: string | undefined, version?: number) {
  return useQuery({
    queryKey: slug ? stepKeys.detail(slug) : DISABLED_QUERY_KEY,
    queryFn: () => {
      if (!slug) throw new Error("Slug is required");
      return workflowService.getStepTemplate(slug, version);
    },
    enabled: !!slug,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Create new step template
 */
export function useCreateStepTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateStepTemplateRequest) => workflowService.createStepTemplate(data),
    onSuccess: () => {
      // Invalidate lists to refetch with new template
      queryClient.invalidateQueries({ queryKey: stepKeys.lists() });
    },
  });
}

/**
 * Update step template (creates new version)
 */
export function useUpdateStepTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ slug, updates }: { slug: string; updates: UpdateStepTemplateRequest }) =>
      workflowService.updateStepTemplate(slug, updates),
    onSuccess: (updatedTemplate) => {
      // Invalidate lists
      queryClient.invalidateQueries({ queryKey: stepKeys.lists() });
      // Invalidate detail for this slug
      queryClient.invalidateQueries({ queryKey: stepKeys.detail(updatedTemplate.slug) });
    },
  });
}
