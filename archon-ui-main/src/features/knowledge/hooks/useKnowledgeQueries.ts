/**
 * Knowledge Base Query Hooks
 * Following TanStack Query best practices with query key factories
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSmartPolling } from "@/features/shared/hooks";
import { useToast } from "@/features/shared/hooks/useToast";
import { createOptimisticEntity, createOptimisticId } from "@/features/shared/utils/optimistic";
import { useActiveOperations } from "../../progress/hooks";
import { progressKeys } from "../../progress/hooks/useProgressQueries";
import type { ActiveOperation, ActiveOperationsResponse } from "../../progress/types";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "../../shared/config/queryPatterns";
import { knowledgeService } from "../services";
import type {
  CrawlRequest,
  CrawlStartResponse,
  KnowledgeItem,
  KnowledgeItemsFilter,
  KnowledgeItemsResponse,
  UploadMetadata,
} from "../types";
import { getProviderErrorMessage } from "../utils/providerErrorHandler";

// Query keys factory for better organization and type safety
export const knowledgeKeys = {
  all: ["knowledge"] as const,
  lists: () => [...knowledgeKeys.all, "list"] as const,
  detail: (id: string) => [...knowledgeKeys.all, "detail", id] as const,
  // Include domain + pagination to avoid cache collisions
  chunks: (id: string, opts?: { domain?: string; limit?: number; offset?: number }) =>
    [
      ...knowledgeKeys.all,
      id,
      "chunks",
      { domain: opts?.domain ?? "all", limit: opts?.limit, offset: opts?.offset },
    ] as const,
  // Include pagination in the key
  codeExamples: (id: string, opts?: { limit?: number; offset?: number }) =>
    [...knowledgeKeys.all, id, "code-examples", { limit: opts?.limit, offset: opts?.offset }] as const,
  // Prefix helper for targeting all summaries queries
  summariesPrefix: () => [...knowledgeKeys.all, "summaries"] as const,
  summaries: (filter?: KnowledgeItemsFilter) => [...knowledgeKeys.all, "summaries", filter] as const,
  sources: () => [...knowledgeKeys.all, "sources"] as const,
  search: (query: string) => [...knowledgeKeys.all, "search", query] as const,
};

/**
 * Fetch a specific knowledge item
 */
export function useKnowledgeItem(sourceId: string | null) {
  return useQuery<KnowledgeItem>({
    queryKey: sourceId ? knowledgeKeys.detail(sourceId) : DISABLED_QUERY_KEY,
    queryFn: () => (sourceId ? knowledgeService.getKnowledgeItem(sourceId) : Promise.reject("No source ID")),
    enabled: !!sourceId,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Fetch document chunks for a knowledge item
 */
export function useKnowledgeItemChunks(
  sourceId: string | null,
  opts?: { domain?: string; limit?: number; offset?: number },
) {
  // See PRPs/local/frontend-state-management-refactor.md Phase 4: Configure Request Deduplication
  return useQuery({
    queryKey: sourceId ? knowledgeKeys.chunks(sourceId, opts) : DISABLED_QUERY_KEY,
    queryFn: () =>
      sourceId
        ? knowledgeService.getKnowledgeItemChunks(sourceId, {
            domainFilter: opts?.domain,
            limit: opts?.limit,
            offset: opts?.offset,
          })
        : Promise.reject("No source ID"),
    enabled: !!sourceId,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Fetch code examples for a knowledge item
 */
export function useCodeExamples(sourceId: string | null) {
  return useQuery({
    queryKey: sourceId ? knowledgeKeys.codeExamples(sourceId) : DISABLED_QUERY_KEY,
    queryFn: () => (sourceId ? knowledgeService.getCodeExamples(sourceId) : Promise.reject("No source ID")),
    enabled: !!sourceId,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Crawl URL mutation with optimistic updates
 * Returns the progressId that can be used to track crawl progress
 */
export function useCrawlUrl() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    CrawlStartResponse,
    Error,
    CrawlRequest,
    {
      previousKnowledge?: KnowledgeItem[];
      previousSummaries?: Array<[readonly unknown[], KnowledgeItemsResponse | undefined]>;
      previousOperations?: ActiveOperationsResponse;
      tempProgressId: string;
      tempItemId: string;
    }
  >({
    mutationFn: (request: CrawlRequest) => knowledgeService.crawlUrl(request),
    onMutate: async (request) => {
      // Cancel any outgoing refetches to prevent race conditions
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.summariesPrefix() });
      await queryClient.cancelQueries({ queryKey: progressKeys.active() });

      // TODO: Fix invisible optimistic updates
      // ISSUE: Optimistic updates are applied to knowledgeKeys.summaries(filter) queries,
      // but the UI component (KnowledgeView) queries with dynamic filters that we don't have access to here.
      // This means optimistic updates only work if the filter happens to match what's being viewed.
      //
      // CURRENT BEHAVIOR:
      // - We update all cached summaries queries (lines 158-179 below)
      // - BUT if the user changes filters after mutation starts, they won't see the optimistic update
      // - AND we have no way to know what filter the user is currently viewing
      //
      // PROPER FIX requires one of:
      // 1. Pass current filter from KnowledgeView to mutation hooks (prop drilling)
      // 2. Create KnowledgeFilterContext to share filter state
      // 3. Restructure to have a single source of truth query key like other features
      //
      // IMPACT: Users don't see immediate feedback when adding knowledge items - items only
      // appear after the server responds (usually 1-3 seconds later)

      // Snapshot the previous values for rollback
      const previousSummaries = queryClient.getQueriesData<KnowledgeItemsResponse>({
        queryKey: knowledgeKeys.summariesPrefix(),
      });
      const previousOperations = queryClient.getQueryData<ActiveOperationsResponse>(progressKeys.active());

      // Generate temporary progress ID and optimistic entity
      const tempProgressId = createOptimisticId();
      const optimisticItem = createOptimisticEntity<KnowledgeItem>({
        title: (() => {
          try {
            return new URL(request.url).hostname || "New crawl";
          } catch {
            return "New crawl";
          }
        })(),
        url: request.url,
        source_id: tempProgressId,
        source_type: "url",
        knowledge_type: request.knowledge_type || "technical",
        status: "processing",
        document_count: 0,
        code_examples_count: 0,
        metadata: {
          knowledge_type: request.knowledge_type || "technical",
          tags: request.tags || [],
          source_type: "url",
          status: "processing",
          description: `Crawling ${request.url}`,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as Omit<KnowledgeItem, "id">);

      // Update all summaries caches with optimistic data, respecting each cache's filter
      const entries = queryClient.getQueriesData<KnowledgeItemsResponse>({
        queryKey: knowledgeKeys.summariesPrefix(),
      });
      for (const [qk, old] of entries) {
        const filter = qk[qk.length - 1] as KnowledgeItemsFilter | undefined;
        const matchesType = !filter?.knowledge_type || optimisticItem.knowledge_type === filter.knowledge_type;
        const matchesTags =
          !filter?.tags || filter.tags.every((t) => (optimisticItem.metadata?.tags ?? []).includes(t));
        if (!(matchesType && matchesTags)) continue;
        if (!old) {
          queryClient.setQueryData<KnowledgeItemsResponse>(qk, {
            items: [optimisticItem],
            total: 1,
            page: 1,
            per_page: 100,
          });
        } else {
          queryClient.setQueryData<KnowledgeItemsResponse>(qk, {
            ...old,
            items: [optimisticItem, ...old.items],
            total: (old.total ?? old.items.length) + 1,
          });
        }
      }

      // Create optimistic progress operation
      const optimisticOperation: ActiveOperation = {
        operation_id: tempProgressId,
        operation_type: "crawl",
        status: "starting",
        progress: 0,
        message: `Initializing crawl for ${request.url}`,
        started_at: new Date().toISOString(),
        progressId: tempProgressId,
        type: "crawl",
        url: request.url,
        source_id: tempProgressId,
      };

      // Add optimistic operation to active operations
      queryClient.setQueryData<ActiveOperationsResponse>(progressKeys.active(), (old) => {
        if (!old) {
          return {
            operations: [optimisticOperation],
            count: 1,
            timestamp: new Date().toISOString(),
          };
        }
        return {
          ...old,
          operations: [optimisticOperation, ...old.operations],
          count: old.count + 1,
        };
      });

      // Return context for rollback and replacement
      return { previousSummaries, previousOperations, tempProgressId, tempItemId: tempProgressId };
    },
    onSuccess: (response, _variables, context) => {
      // Replace temporary IDs with real ones from the server
      if (context) {
        // Update summaries cache with real progress ID
        queryClient.setQueriesData<KnowledgeItemsResponse>({ queryKey: knowledgeKeys.summariesPrefix() }, (old) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((item) => {
              if (item.source_id === context.tempProgressId) {
                return {
                  ...item,
                  source_id: response.progressId,
                };
              }
              return item;
            }),
          };
        });

        // Update progress operation with real progress ID
        queryClient.setQueryData<ActiveOperationsResponse>(progressKeys.active(), (old) => {
          if (!old) return old;
          return {
            ...old,
            operations: old.operations.map((op) => {
              if (op.operation_id === context.tempProgressId) {
                return {
                  ...op,
                  operation_id: response.progressId,
                  progressId: response.progressId,
                  source_id: response.progressId,
                  message: response.message || op.message,
                };
              }
              return op;
            }),
          };
        });
      }

      // Invalidate to get fresh data
      queryClient.invalidateQueries({ queryKey: progressKeys.active() });

      showToast(`Crawl started: ${response.message}`, "success");

      // Return the response so caller can access progressId
      return response;
    },
    onError: (error, _variables, context) => {
      // Rollback optimistic updates on error
      if (context?.previousSummaries) {
        // Rollback all summary queries
        for (const [queryKey, data] of context.previousSummaries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
      if (context?.previousOperations) {
        queryClient.setQueryData(progressKeys.active(), context.previousOperations);
      }

      const errorMessage = getProviderErrorMessage(error) || "Failed to start crawl";
      showToast(errorMessage, "error");
    },
  });
}

/**
 * Upload document mutation with optimistic updates
 */
export function useUploadDocument() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    { progressId: string; message: string },
    Error,
    { file: File; metadata: UploadMetadata },
    {
      previousSummaries?: Array<[readonly unknown[], KnowledgeItemsResponse | undefined]>;
      previousOperations?: ActiveOperationsResponse;
      tempProgressId: string;
    }
  >({
    mutationFn: ({ file, metadata }: { file: File; metadata: UploadMetadata }) =>
      knowledgeService.uploadDocument(file, metadata),
    onMutate: async ({ file, metadata }) => {
      // Cancel any outgoing refetches to prevent race conditions
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.summariesPrefix() });
      await queryClient.cancelQueries({ queryKey: progressKeys.active() });

      // Snapshot the previous values for rollback
      const previousSummaries = queryClient.getQueriesData<KnowledgeItemsResponse>({
        queryKey: knowledgeKeys.summariesPrefix(),
      });
      const previousOperations = queryClient.getQueryData<ActiveOperationsResponse>(progressKeys.active());

      const tempProgressId = createOptimisticId();

      // Create optimistic knowledge item for the upload
      const optimisticItem = createOptimisticEntity<KnowledgeItem>({
        title: file.name,
        url: `file://${file.name}`,
        source_id: tempProgressId,
        source_type: "file",
        knowledge_type: metadata.knowledge_type || "technical",
        status: "processing",
        document_count: 0,
        code_examples_count: 0,
        metadata: {
          knowledge_type: metadata.knowledge_type || "technical",
          tags: metadata.tags || [],
          source_type: "file",
          status: "processing",
          description: `Uploading ${file.name}`,
          file_name: file.name,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as Omit<KnowledgeItem, "id">);

      // Respect each cache's filter (knowledge_type, tags, etc.)
      const entries = queryClient.getQueriesData<KnowledgeItemsResponse>({
        queryKey: knowledgeKeys.summariesPrefix(),
      });
      for (const [qk, old] of entries) {
        const filter = qk[qk.length - 1] as KnowledgeItemsFilter | undefined;
        const matchesType = !filter?.knowledge_type || optimisticItem.knowledge_type === filter.knowledge_type;
        const matchesTags =
          !filter?.tags || filter.tags.every((t) => (optimisticItem.metadata?.tags ?? []).includes(t));
        if (!(matchesType && matchesTags)) continue;
        if (!old) {
          queryClient.setQueryData<KnowledgeItemsResponse>(qk, {
            items: [optimisticItem],
            total: 1,
            page: 1,
            per_page: 100,
          });
        } else {
          queryClient.setQueryData<KnowledgeItemsResponse>(qk, {
            ...old,
            items: [optimisticItem, ...old.items],
            total: (old.total ?? old.items.length) + 1,
          });
        }
      }

      // Create optimistic progress operation for upload
      const optimisticOperation: ActiveOperation = {
        operation_id: tempProgressId,
        operation_type: "upload",
        status: "starting",
        progress: 0,
        message: `Uploading ${file.name}`,
        started_at: new Date().toISOString(),
        progressId: tempProgressId,
        type: "upload",
        url: `file://${file.name}`,
        source_id: tempProgressId,
      };

      // Add optimistic operation to active operations
      queryClient.setQueryData<ActiveOperationsResponse>(progressKeys.active(), (old) => {
        if (!old) {
          return {
            operations: [optimisticOperation],
            count: 1,
            timestamp: new Date().toISOString(),
          };
        }
        return {
          ...old,
          operations: [optimisticOperation, ...old.operations],
          count: old.count + 1,
        };
      });

      return { previousSummaries, previousOperations, tempProgressId, tempItemId: tempProgressId };
    },
    onSuccess: (response, _variables, context) => {
      // Replace temporary IDs with real ones from the server
      if (context && response?.progressId) {
        // Update summaries cache with real progress ID
        queryClient.setQueriesData<KnowledgeItemsResponse>({ queryKey: knowledgeKeys.summariesPrefix() }, (old) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((item) => {
              if (item.source_id === context.tempProgressId) {
                return {
                  ...item,
                  source_id: response.progressId,
                };
              }
              return item;
            }),
          };
        });

        // Update progress operation with real progress ID
        queryClient.setQueryData<ActiveOperationsResponse>(progressKeys.active(), (old) => {
          if (!old) return old;
          return {
            ...old,
            operations: old.operations.map((op) => {
              if (op.operation_id === context.tempProgressId) {
                return {
                  ...op,
                  operation_id: response.progressId,
                  progressId: response.progressId,
                  source_id: response.progressId,
                  message: response.message || op.message,
                };
              }
              return op;
            }),
          };
        });
      }

      // Only invalidate progress to start tracking the new operation
      // The lists/summaries will refresh automatically via polling when operations are active
      queryClient.invalidateQueries({ queryKey: progressKeys.active() });

      // Don't show success here - upload is just starting in background
      // Success/failure will be shown via progress polling
    },
    onError: (error, _variables, context) => {
      // Rollback optimistic updates on error
      if (context?.previousSummaries) {
        for (const [queryKey, data] of context.previousSummaries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
      if (context?.previousOperations) {
        queryClient.setQueryData(progressKeys.active(), context.previousOperations);
      }

      // Display the actual error message from backend
      const message = error instanceof Error ? error.message : "Failed to upload document";
      showToast(message, "error");
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
    onSuccess: (_data, progressId) => {
      showToast(`Stop requested (${progressId}). Operation will end shortly.`, "info");
    },
    onError: (error, progressId) => {
      // If it's a 404, the operation might have already completed or been cancelled
      // See PRPs/local/frontend-state-management-refactor.md Phase 4: Configure Request Deduplication
      const is404Error =
        (error as any)?.statusCode === 404 ||
        (error instanceof Error && (error.message.includes("404") || error.message.includes("not found")));

      if (is404Error) {
        // Don't show error for 404s - the operation is likely already gone
        return;
      }

      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      showToast(`Failed to stop crawl (${progressId}): ${errorMessage}`, "error");
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
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.summariesPrefix() });

      // Snapshot all summary caches (for all filters)
      const summariesPrefix = knowledgeKeys.summariesPrefix();
      const previousEntries = queryClient.getQueriesData<KnowledgeItemsResponse>({
        queryKey: summariesPrefix,
      });

      // Optimistically remove the item from each cached summary
      for (const [queryKey, data] of previousEntries) {
        if (!data) continue;
        const nextItems = data.items.filter((item) => item.source_id !== sourceId);
        const removed = data.items.length - nextItems.length;
        queryClient.setQueryData<KnowledgeItemsResponse>(queryKey, {
          ...data,
          items: nextItems,
          total: Math.max(0, (data.total ?? data.items.length) - removed),
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
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.summariesPrefix() });
      // Also invalidate detail views
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
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
    mutationFn: ({ sourceId, updates }: { sourceId: string; updates: Partial<KnowledgeItem> & { tags?: string[] } }) =>
      knowledgeService.updateKnowledgeItem(sourceId, updates),
    onMutate: async ({ sourceId, updates }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.detail(sourceId) });
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.summariesPrefix() });

      // Snapshot the previous values
      const previousItem = queryClient.getQueryData<KnowledgeItem>(knowledgeKeys.detail(sourceId));
      const previousSummaries = queryClient.getQueriesData({ queryKey: knowledgeKeys.summariesPrefix() });

      // Optimistically update the detail item
      if (previousItem) {
        const updatedItem = { ...previousItem };

        // Initialize metadata if missing
        const currentMetadata = updatedItem.metadata || {};

        // Handle title updates
        if ("title" in updates && typeof updates.title === "string") {
          updatedItem.title = updates.title;
        }

        // Handle tags updates - update in metadata only
        if ("tags" in updates && Array.isArray(updates.tags)) {
          const newTags = updates.tags as string[];
          updatedItem.metadata = {
            ...currentMetadata,
            tags: newTags,
          };
        }

        // Handle knowledge_type updates
        if ("knowledge_type" in updates && typeof updates.knowledge_type === "string") {
          const newType = updates.knowledge_type as "technical" | "business";
          updatedItem.knowledge_type = newType;
          // Also update in metadata for consistency
          updatedItem.metadata = {
            ...updatedItem.metadata,
            knowledge_type: newType,
          };
        }

        queryClient.setQueryData<KnowledgeItem>(knowledgeKeys.detail(sourceId), updatedItem);
      }

      // Optimistically update summaries cache
      queryClient.setQueriesData<KnowledgeItemsResponse>({ queryKey: knowledgeKeys.summariesPrefix() }, (old) => {
        if (!old?.items) return old;

        return {
          ...old,
          items: old.items.map((item) => {
            if (item.source_id === sourceId) {
              const updatedItem = { ...item };

              // Initialize metadata if missing
              const currentMetadata = updatedItem.metadata || {};

              // Update title if provided
              if ("title" in updates && typeof updates.title === "string") {
                updatedItem.title = updates.title;
              }

              // Update tags if provided - update in metadata only
              if ("tags" in updates && Array.isArray(updates.tags)) {
                const newTags = updates.tags as string[];
                updatedItem.metadata = {
                  ...currentMetadata,
                  tags: newTags,
                };
              }

              // Update knowledge_type if provided
              if ("knowledge_type" in updates && typeof updates.knowledge_type === "string") {
                const newType = updates.knowledge_type as "technical" | "business";
                updatedItem.knowledge_type = newType;
                // Also update in metadata for consistency
                updatedItem.metadata = {
                  ...updatedItem.metadata,
                  knowledge_type: newType,
                };
              }

              return updatedItem;
            }
            return item;
          }),
        };
      });

      return { previousItem, previousSummaries };
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousItem) {
        queryClient.setQueryData(knowledgeKeys.detail(variables.sourceId), context.previousItem);
      }
      if (context?.previousSummaries) {
        // Rollback all summary queries
        for (const [queryKey, data] of context.previousSummaries) {
          queryClient.setQueryData(queryKey, data);
        }
      }

      const errorMessage = error instanceof Error ? error.message : "Failed to update item";
      showToast(errorMessage, "error");
    },
    onSuccess: (_data, { sourceId }) => {
      showToast("Item updated successfully", "success");

      // Invalidate all related queries
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.detail(sourceId) });
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.summariesPrefix() });
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

      // Invalidate summaries immediately - backend is consistent after refresh initiation
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.summariesPrefix() });

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
  const { refetchInterval } = useSmartPolling(hasActiveOperations ? STALE_TIMES.frequent : STALE_TIMES.normal);

  const summaryQuery = useQuery<KnowledgeItemsResponse>({
    queryKey: knowledgeKeys.summaries(filter),
    queryFn: () => knowledgeService.getKnowledgeSummaries(filter),
    refetchInterval: hasActiveOperations ? refetchInterval : false, // Poll when ANY operations are active
    refetchOnWindowFocus: true,
    staleTime: STALE_TIMES.normal, // Consider data stale after 30 seconds
  });

  // When operations complete, remove them from tracking
  // Trust smart polling to handle eventual consistency - no manual invalidation needed
  // Active operations are already tracked and polling handles updates when operations complete

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
      ? knowledgeKeys.chunks(sourceId, { limit: options?.limit, offset: options?.offset })
      : DISABLED_QUERY_KEY,
    queryFn: () =>
      sourceId
        ? knowledgeService.getKnowledgeItemChunks(sourceId, {
            limit: options?.limit,
            offset: options?.offset,
          })
        : Promise.reject("No source ID"),
    enabled: options?.enabled !== false && !!sourceId,
    staleTime: STALE_TIMES.normal,
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
      ? knowledgeKeys.codeExamples(sourceId, { limit: options?.limit, offset: options?.offset })
      : DISABLED_QUERY_KEY,
    queryFn: () =>
      sourceId
        ? knowledgeService.getCodeExamples(sourceId, {
            limit: options?.limit,
            offset: options?.offset,
          })
        : Promise.reject("No source ID"),
    enabled: options?.enabled !== false && !!sourceId,
    staleTime: STALE_TIMES.normal,
  });
}
