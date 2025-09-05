import { useQuery } from "@tanstack/react-query";
import { projectService } from "../../services";
import type { ProjectDocument } from "../types";

// Query keys
const documentKeys = {
  all: (projectId: string) => ["projects", projectId, "documents"] as const,
};

/**
 * Get documents from project's docs JSONB field
 * Read-only - no mutations
 */
export function useProjectDocuments(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? documentKeys.all(projectId) : ["documents-undefined"],
    queryFn: async () => {
      if (!projectId) return [];
      const project = await projectService.getProject(projectId);
      return (project.docs || []) as ProjectDocument[];
    },
    enabled: !!projectId,
  });
}
