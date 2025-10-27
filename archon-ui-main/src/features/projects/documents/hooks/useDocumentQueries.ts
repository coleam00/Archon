import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { callAPIWithETag } from "../../../shared/api/apiClient";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "../../../shared/config/queryPatterns";
import { useToast } from "../../../shared/hooks/useToast";
import { documentService } from "../services/documentService";
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
 * Get documents for a project from Archon documents API
 */
export function useProjectDocuments(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? documentKeys.byProject(projectId) : DISABLED_QUERY_KEY,
    queryFn: async () => {
      if (!projectId) return [];
      return await documentService.getDocumentsByProject(projectId);
    },
    enabled: !!projectId,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Get a single document by ID
 */
export function useProjectDocument(projectId: string | undefined, documentId: string | undefined) {
  return useQuery({
    queryKey: projectId && documentId ? documentKeys.detail(projectId, documentId) : DISABLED_QUERY_KEY,
    queryFn: async () => {
      if (!projectId || !documentId) return null;
      return await documentService.getDocument(projectId, documentId);
    },
    enabled: !!(projectId && documentId),
    staleTime: STALE_TIMES.normal,
  });
}

// Type for document updates
export interface DocumentUpdateData {
  documentId: string;
  updates: { title?: string; content?: unknown; tags?: string[]; author?: string };
}

/**
 * Update a project document
 */
export function useUpdateDocument(projectId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async ({ documentId, updates }: DocumentUpdateData) => {
      return await documentService.updateDocument(projectId, documentId, updates);
    },

    onSuccess: (_, variables) => {
      // Invalidate documents list to refetch with new content
      queryClient.invalidateQueries({ queryKey: documentKeys.byProject(projectId) });
      // Invalidate the specific document detail to update open viewers
      queryClient.invalidateQueries({ queryKey: documentKeys.detail(projectId, variables.documentId) });
      showToast("Document updated successfully", "success");
    },

    onError: (error: Error) => {
      showToast(`Failed to update document: ${error.message}`, "error");
    },
  });
}

/**
 * Create a new project document
 */
export function useCreateDocument(projectId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (document: {
      title: string;
      document_type: string;
      content?: any;
      tags?: string[];
      author?: string;
    }) => {
      const response = await callAPIWithETag<{ success: boolean; message: string; document: ProjectDocument }>(
        `/api/projects/${projectId}/docs`,
        {
          method: "POST",
          body: JSON.stringify(document),
        },
      );
      return response.document;
    },

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentKeys.byProject(projectId) });
      showToast("Document created successfully", "success");
    },

    onError: (error: Error) => {
      showToast(`Failed to create document: ${error.message}`, "error");
    },
  });
}

/**
 * Delete a project document
 */
export function useDeleteDocument(projectId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (documentId: string) => {
      return await documentService.deleteDocument(projectId, documentId);
    },

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentKeys.byProject(projectId) });
      showToast("Document deleted successfully", "success");
    },

    onError: (error: Error) => {
      showToast(`Failed to delete document: ${error.message}`, "error");
    },
  });
}
