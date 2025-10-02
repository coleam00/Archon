import { useQuery } from "@tanstack/react-query";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "../../../shared/config/queryPatterns";
import { projectService } from "../../services";
import type { ProjectDocument } from "../types";

// Query keys factory for documents
export const documentKeys = {
  all: ["documents"] as const,
  byProject: (projectId: string) => ["projects", projectId, "documents"] as const,
  detail: (projectId: string, docId: string) => ["projects", projectId, "documents", "detail", docId] as const,
  versions: (projectId: string) => ["projects", projectId, "versions"] as const,
  version: (projectId: string, fieldName: string, version: number) =>
    ["projects", projectId, "versions", fieldName, version] as const,
};

/**
 * Get documents from project's docs JSONB field
 * Read-only - no mutations
 */
export function useProjectDocuments(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? documentKeys.byProject(projectId) : DISABLED_QUERY_KEY,
    queryFn: async () => {
      if (!projectId) return [];
      const project = await projectService.getProject(projectId);
      return (project.docs || []) as ProjectDocument[];
    },
    enabled: !!projectId,
    staleTime: STALE_TIMES.normal,
  });
}
