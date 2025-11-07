/**
 * Agent Template Query Hooks
 *
 * TanStack Query hooks for agent template CRUD operations.
 * Handles server state management for agent templates.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "@/features/shared/config/queryPatterns";
import { templateService } from "../services";
import type { AgentTemplate, CreateAgentTemplateRequest, UpdateAgentTemplateRequest } from "../types";

/**
 * Query key factory for agent templates
 */
export const agentKeys = {
  all: ["context-hub", "agents"] as const,
  lists: () => [...agentKeys.all, "list"] as const,
  detail: (slug: string) => [...agentKeys.all, "detail", slug] as const,
  versions: (slug: string) => [...agentKeys.all, "versions", slug] as const,
};

/**
 * List all agent templates
 */
export function useAgentTemplates(isActive?: boolean, latestOnly: boolean = true) {
  return useQuery({
    queryKey: [...agentKeys.lists(), { isActive, latestOnly }],
    queryFn: () => templateService.listAgentTemplates(isActive, latestOnly),
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Get agent template by slug
 */
export function useAgentTemplate(slug: string | undefined, version?: number) {
  return useQuery({
    queryKey: slug ? agentKeys.detail(slug) : DISABLED_QUERY_KEY,
    queryFn: () => {
      if (!slug) throw new Error("Slug is required");
      return templateService.getAgentTemplate(slug, version);
    },
    enabled: !!slug,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Get all versions of an agent template
 */
export function useAgentTemplateVersions(slug: string | undefined) {
  return useQuery({
    queryKey: slug ? agentKeys.versions(slug) : DISABLED_QUERY_KEY,
    queryFn: () => {
      if (!slug) throw new Error("Slug is required");
      return templateService.getTemplateVersions(slug);
    },
    enabled: !!slug,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Create new agent template
 */
export function useCreateAgentTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateAgentTemplateRequest) => templateService.createAgentTemplate(data),
    onSuccess: () => {
      // Invalidate lists to refetch with new template
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}

/**
 * Update agent template (creates new version)
 */
export function useUpdateAgentTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ slug, updates }: { slug: string; updates: UpdateAgentTemplateRequest }) =>
      templateService.updateAgentTemplate(slug, updates),
    onSuccess: (updatedTemplate) => {
      // Invalidate lists
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      // Invalidate detail for this slug
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(updatedTemplate.slug) });
      // Invalidate versions
      queryClient.invalidateQueries({ queryKey: agentKeys.versions(updatedTemplate.slug) });
    },
  });
}
