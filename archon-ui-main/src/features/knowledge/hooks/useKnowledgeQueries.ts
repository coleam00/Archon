/**
 * Knowledge Base Query Hooks
 * Following TanStack Query best practices with query key factories
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSmartPolling } from "../../ui/hooks";
import { useToast } from "../../ui/hooks/useToast";
import { useActiveOperations } from "../progress/hooks";
import type { ActiveOperation } from "../progress/types";
import { knowledgeService } from "../services";
import type {
  CrawlRequest,
  KnowledgeItem,
  KnowledgeItemsFilter,
  KnowledgeItemsResponse,
  UploadMetadata,
} from "../types";

// Query keys factory for better organization and type safety
export const knowledgeKeys = {
  all: ["knowledge"] as const,
  lists: () => [...knowledgeKeys.all, "list"] as const,
  list: (filters?: KnowledgeItemsFilter) => [...knowledgeKeys.lists(), filters] as const,
  details: () => [...knowledgeKeys.all, "detail"] as const,
  detail: (sourceId: string) => [...knowledgeKeys.details(), sourceId] as const,
  chunks: (sourceId: string, domainFilter?: string) =>
    [...knowledgeKeys.detail(sourceId), "chunks", domainFilter] as const,
  codeExamples: (sourceId: string) => [...knowledgeKeys.detail(sourceId), "code-examples"] as const,
  search: (query: string) => [...knowledgeKeys.all, "search", query] as const,
  sources: () => [...knowledgeKeys.all, "sources"] as const,
  summary: () => [...knowledgeKeys.all, "summary"] as const,
  summaries: (filter?: KnowledgeItemsFilter) => [...knowledgeKeys.summary(), filter] as const,
};

/**
 * Fetch a specific knowledge item
 */
export function useKnowledgeItem(sourceId: string | null) {
  return useQuery<KnowledgeItem>({
    queryKey: sourceId ? knowledgeKeys.detail(sourceId) : ["knowledge-undefined"],
    queryFn: () => (sourceId ? knowledgeService.getKnowledgeItem(sourceId) : Promise.reject("No source ID")),
    enabled: !!sourceId,
    staleTime: 30000, // Cache for 30 seconds
  });
}

/**
 * Fetch document chunks for a knowledge item
 */
export function useKnowledgeItemChunks(sourceId: string | null, domainFilter?: string) {
  return useQuery({
    queryKey: sourceId ? knowledgeKeys.chunks(sourceId, domainFilter) : ["chunks-undefined"],
    queryFn: () =>
      sourceId ? knowledgeService.getKnowledgeItemChunks(sourceId, { domainFilter }) : Promise.reject("No source ID"),
    enabled: !!sourceId,
    staleTime: 60000, // Cache for 1 minute
  });
}

/**
 * Fetch code examples for a knowledge item
 */
export function useCodeExamples(sourceId: string | null) {
  return useQuery({
    queryKey: sourceId ? knowledgeKeys.codeExamples(sourceId) : ["code-examples-undefined"],
    queryFn: () => (sourceId ? knowledgeService.getCodeExamples(sourceId) : Promise.reject("No source ID")),
    enabled: !!sourceId,
    staleTime: 60000, // Cache for 1 minute
  });
}

/**
 * Crawl URL mutation
 * Returns the progressId that can be used to track crawl progress
 */
export function useCrawlUrl() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (request: CrawlRequest) => knowledgeService.crawlUrl(request),
    onSuccess: (response) => {
      // Store the progressId for tracking
      // The response contains progressId which should be used with useOperationProgress

      // Invalidate the list to show new items when ready
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });

      showToast(`Crawl started: ${response.message}`, "success");

      // Return the response so caller can access progressId
      return response;
    },
    onError: () => {
      showToast("Failed to start crawl", "error");
    },
  });
}

/**
 * Upload document mutation
 */
export function useUploadDocument() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: ({ file, metadata }: { file: File; metadata: UploadMetadata }) =>
      knowledgeService.uploadDocument(file, metadata),
    onSuccess: (response) => {
      // Invalidate the list to show new items when ready
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists() });
      showToast(`Document uploaded: ${response.filename}`, "success");
    },
    onError: () => {
      showToast("Failed to upload document", "error");
    },
  });
}

/**
 * Stop crawl mutation
 */
export function useStopCrawl() {
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (progressId: string) => knowledgeService.stopCrawl(progressId),
    onSuccess: () => {
      showToast("Stopping crawl operation...", "info");
    },
    onError: (error) => {
      // If it's a 404, the operation might have already completed or been cancelled
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (errorMessage.includes("404") || errorMessage.includes("not found")) {
        // Don't show error for 404s - the operation is likely already gone
        return;
      }
      showToast("Failed to stop crawl", "error");
    },
  });
}

/**
 * Delete knowledge item mutation
 */
export function useDeleteKnowledgeItem() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (sourceId: string) => knowledgeService.deleteKnowledgeItem(sourceId),
    onMutate: async (sourceId) => {
      // Cancel summary queries (all filters)
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.summary() });

      // Snapshot all summary caches (for all filters)
      const summariesPrefix = knowledgeKeys.summary();
      const previousEntries = queryClient.getQueriesData<KnowledgeItemsResponse>({
        queryKey: summariesPrefix,
      });

      // Optimistically remove the item from each cached summary
      for (const [queryKey, data] of previousEntries) {
        if (!data) continue;
        queryClient.setQueryData<KnowledgeItemsResponse>(queryKey, {
          ...data,
          items: data.items.filter((item) => item.source_id !== sourceId),
          total: Math.max(0, (data.total ?? data.items.length) - 1),
        });
      }

      return { previousEntries };
    },
    onError: (error, _sourceId, context) => {
      // Roll back all summaries
      for (const [queryKey, data] of context?.previousEntries ?? []) {
        queryClient.setQueryData(queryKey, data);
      }

      const errorMessage = error instanceof Error ? error.message : "Failed to delete item";
      showToast(errorMessage, "error");
    },
    onSuccess: (data) => {
      showToast(data.message || "Item deleted successfully", "success");

      // Invalidate summaries to reconcile with server
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.summary() });
      // Also invalidate detail view if it exists
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.details() });
    },
  });
}

/**
 * Update knowledge item mutation
 */
export function useUpdateKnowledgeItem() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: ({ sourceId, updates }: { sourceId: string; updates: Partial<KnowledgeItem> }) =>
      knowledgeService.updateKnowledgeItem(sourceId, updates),
    onMutate: async ({ sourceId, updates }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.detail(sourceId) });

      // Snapshot the previous value
      const previousItem = queryClient.getQueryData<KnowledgeItem>(knowledgeKeys.detail(sourceId));

      // Optimistically update the item
      if (previousItem) {
        queryClient.setQueryData<KnowledgeItem>(knowledgeKeys.detail(sourceId), {
          ...previousItem,
          ...updates,
        });
      }

      return { previousItem };
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousItem) {
        queryClient.setQueryData(knowledgeKeys.detail(variables.sourceId), context.previousItem);
      }

      const errorMessage = error instanceof Error ? error.message : "Failed to update item";
      showToast(errorMessage, "error");
    },
    onSuccess: (_data, { sourceId }) => {
      showToast("Item updated successfully", "success");

      // Invalidate both detail and list queries
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.detail(sourceId) });
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists() });
    },
  });
}

/**
 * Refresh knowledge item mutation
 */
export function useRefreshKnowledgeItem() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (sourceId: string) => knowledgeService.refreshKnowledgeItem(sourceId),
    onSuccess: (data, sourceId) => {
      showToast("Refresh started", "success");

      // Remove the item from cache as it's being refreshed
      queryClient.removeQueries({ queryKey: knowledgeKeys.detail(sourceId) });

      // Invalidate list after a delay
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists() });
      }, 5000);

      return data;
    },
    onError: (error) => {
      const errorMessage = error instanceof Error ? error.message : "Failed to refresh item";
      showToast(errorMessage, "error");
    },
  });
}

/**
 * Knowledge Summaries Hook with Active Operations Tracking
 * Fetches lightweight summaries and tracks active crawl operations
 * Only polls when there are active operations that we started
 */
export function useKnowledgeSummaries(filter?: KnowledgeItemsFilter) {
  const queryClient = useQueryClient();

  // Track active crawl IDs locally - only set when we start a crawl/refresh
  const [activeCrawlIds, setActiveCrawlIds] = useState<string[]>([]);

  // ALWAYS poll for active operations to catch pre-existing ones
  // This ensures we discover operations that were started before page load
  const { data: activeOperationsData } = useActiveOperations(true);

  // Check if we have any active operations (either tracked or discovered)
  const hasActiveOperations = (activeOperationsData?.operations?.length || 0) > 0;

  // Convert to the format expected by components
  const activeOperations: ActiveOperation[] = useMemo(() => {
    if (!activeOperationsData?.operations) return [];

    // Include ALL active operations (not just tracked ones) to catch pre-existing operations
    // This ensures operations started before page load are still shown
    return activeOperationsData.operations.map((op) => ({
      ...op,
      progressId: op.operation_id,
      type: op.operation_type,
    }));
  }, [activeOperationsData]);

  // Fetch summaries with smart polling when there are active operations
  const { refetchInterval } = useSmartPolling(hasActiveOperations ? 5000 : 30000);

  const summaryQuery = useQuery<KnowledgeItemsResponse>({
    queryKey: knowledgeKeys.summaries(filter),
    queryFn: () => knowledgeService.getKnowledgeSummaries(filter),
    refetchInterval: hasActiveOperations ? refetchInterval : false, // Poll when ANY operations are active
    refetchOnWindowFocus: true,
    staleTime: 30000, // Consider data stale after 30 seconds
  });

  // When operations complete, remove them from tracking
  useEffect(() => {
    const completedOps = activeOperations.filter(
      (op) => op.status === "completed" || op.status === "failed" || op.status === "error",
    );

    if (completedOps.length > 0) {
      // Remove completed operations from tracking
      setActiveCrawlIds((prev) => prev.filter((id) => !completedOps.some((op) => op.progressId === id)));

      // Invalidate after a short delay to allow backend to update
      const timer = setTimeout(() => {
        // Invalidate all summaries regardless of filter
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.summary() });
      }, 2000);

      return () => clearTimeout(timer);
    }
  }, [activeOperations, queryClient]);

  return {
    ...summaryQuery,
    activeCrawlIds,
    setActiveCrawlIds, // Export this so components can add IDs when starting operations
    activeOperations,
  };
}

/**
 * Fetch document chunks with pagination
 */
export function useKnowledgeChunks(
  sourceId: string | null,
  options?: { limit?: number; offset?: number; enabled?: boolean },
) {
  return useQuery({
    queryKey: sourceId
      ? [...knowledgeKeys.detail(sourceId), "chunks", options?.limit, options?.offset]
      : ["chunks-undefined"],
    queryFn: () =>
      sourceId
        ? knowledgeService.getKnowledgeItemChunks(sourceId, {
            limit: options?.limit,
            offset: options?.offset,
          })
        : Promise.reject("No source ID"),
    enabled: options?.enabled !== false && !!sourceId,
    staleTime: 60000, // Cache for 1 minute
  });
}

/**
 * Fetch code examples with pagination
 */
export function useKnowledgeCodeExamples(
  sourceId: string | null,
  options?: { limit?: number; offset?: number; enabled?: boolean },
) {
  return useQuery({
    queryKey: sourceId
      ? [...knowledgeKeys.codeExamples(sourceId), options?.limit, options?.offset]
      : ["code-examples-undefined"],
    queryFn: () =>
      sourceId
        ? knowledgeService.getCodeExamples(sourceId, {
            limit: options?.limit,
            offset: options?.offset,
          })
        : Promise.reject("No source ID"),
    enabled: options?.enabled !== false && !!sourceId,
    staleTime: 60000, // Cache for 1 minute
  });
}
