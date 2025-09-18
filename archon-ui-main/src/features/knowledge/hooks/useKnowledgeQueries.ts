/**
 * Knowledge Base Query Hooks
 * Following TanStack Query best practices with query key factories
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSmartPolling } from "../../ui/hooks";
import { useToast } from "../../ui/hooks/useToast";
import { useActiveOperations } from "../progress/hooks";
import { progressKeys } from "../progress/hooks/useProgressQueries";
import type { ActiveOperation, ActiveOperationsResponse } from "../progress/types";
import { knowledgeService } from "../services";
import type {
  CrawlRequest,
  CrawlStartResponse,
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
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.lists() });
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.summary() });
      await queryClient.cancelQueries({ queryKey: progressKeys.list() });

      // Snapshot the previous values for rollback
      const previousKnowledge = queryClient.getQueryData<KnowledgeItem[]>(knowledgeKeys.lists());
      const previousSummaries = queryClient.getQueriesData<KnowledgeItemsResponse>({
        queryKey: knowledgeKeys.summary(),
      });
      const previousOperations = queryClient.getQueryData<ActiveOperationsResponse>(progressKeys.list());

      // Generate temporary IDs
      const tempProgressId = `temp-progress-${Date.now()}`;
      const tempItemId = `temp-item-${Date.now()}`;

      // Create optimistic knowledge item
      const optimisticItem: KnowledgeItem = {
        id: tempItemId,
        title: new URL(request.url).hostname || "New crawl",
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
      };

      // Add optimistic knowledge item to the list
      queryClient.setQueryData<KnowledgeItem[]>(knowledgeKeys.lists(), (old) => {
        if (!old) return [optimisticItem];
        // Add at the beginning for visibility
        return [optimisticItem, ...old];
      });

      // CRITICAL: Also add optimistic item to SUMMARIES cache (what the UI actually uses!)
      // This ensures the card shows up immediately in the knowledge base view
      queryClient.setQueriesData<KnowledgeItemsResponse>({ queryKey: knowledgeKeys.summary() }, (old) => {
        if (!old) {
          return {
            items: [optimisticItem],
            total: 1,
            page: 1,
            per_page: 100,
            pages: 1,
          };
        }
        return {
          ...old,
          items: [optimisticItem, ...old.items],
          total: old.total + 1,
        };
      });

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
      queryClient.setQueryData<ActiveOperationsResponse>(progressKeys.list(), (old) => {
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
      return { previousKnowledge, previousSummaries, previousOperations, tempProgressId, tempItemId };
    },
    onSuccess: (response, _variables, context) => {
      // Replace temporary IDs with real ones from the server
      if (context) {
        // Update knowledge item with real source_id if we get it
        queryClient.setQueryData<KnowledgeItem[]>(knowledgeKeys.lists(), (old) => {
          if (!old) return old;
          return old.map((item) => {
            if (item.id === context.tempItemId) {
              // Update with real progress ID, but keep the optimistic item
              // The real item will come through polling/invalidation
              return {
                ...item,
                source_id: response.progressId,
              };
            }
            return item;
          });
        });

        // Also update summaries cache with real progress ID
        queryClient.setQueriesData<KnowledgeItemsResponse>({ queryKey: knowledgeKeys.summary() }, (old) => {
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
        queryClient.setQueryData<ActiveOperationsResponse>(progressKeys.list(), (old) => {
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
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: progressKeys.list() });

      showToast(`Crawl started: ${response.message}`, "success");

      // Return the response so caller can access progressId
      return response;
    },
    onError: (error, _variables, context) => {
      // Rollback optimistic updates on error
      if (context?.previousKnowledge) {
        queryClient.setQueryData(knowledgeKeys.lists(), context.previousKnowledge);
      }
      if (context?.previousSummaries) {
        // Rollback all summary queries
        for (const [queryKey, data] of context.previousSummaries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
      if (context?.previousOperations) {
        queryClient.setQueryData(progressKeys.list(), context.previousOperations);
      }

      const errorMessage = error instanceof Error ? error.message : "Failed to start crawl";
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
      tempItemId: string;
    }
  >({
    mutationFn: ({ file, metadata }: { file: File; metadata: UploadMetadata }) =>
      knowledgeService.uploadDocument(file, metadata),
    onMutate: async ({ file, metadata }) => {
      // Cancel any outgoing refetches to prevent race conditions
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.summary() });
      await queryClient.cancelQueries({ queryKey: progressKeys.list() });

      // Snapshot the previous values for rollback
      const previousSummaries = queryClient.getQueriesData<KnowledgeItemsResponse>({
        queryKey: knowledgeKeys.summary(),
      });
      const previousOperations = queryClient.getQueryData<ActiveOperationsResponse>(progressKeys.list());

      // Generate temporary IDs
      const tempProgressId = `temp-upload-${Date.now()}`;
      const tempItemId = `temp-item-${Date.now()}`;

      // Create optimistic knowledge item for the upload
      const optimisticItem: KnowledgeItem = {
        id: tempItemId,
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
          filename: file.name,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Add optimistic item to SUMMARIES cache (what the UI uses!)
      queryClient.setQueriesData<KnowledgeItemsResponse>({ queryKey: knowledgeKeys.summary() }, (old) => {
        if (!old) {
          return {
            items: [optimisticItem],
            total: 1,
            page: 1,
            per_page: 100,
            pages: 1,
          };
        }
        return {
          ...old,
          items: [optimisticItem, ...old.items],
          total: old.total + 1,
        };
      });

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
      queryClient.setQueryData<ActiveOperationsResponse>(progressKeys.list(), (old) => {
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

      return { previousSummaries, previousOperations, tempProgressId, tempItemId };
    },
    onSuccess: (response, _variables, context) => {
      // Replace temporary IDs with real ones from the server
      if (context && response?.progressId) {
        // Update summaries cache with real progress ID
        queryClient.setQueriesData<KnowledgeItemsResponse>({ queryKey: knowledgeKeys.summary() }, (old) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((item) => {
              if (item.id === context.tempItemId) {
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
        queryClient.setQueryData<ActiveOperationsResponse>(progressKeys.list(), (old) => {
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

      // Invalidate queries to get fresh data - with a short delay for fast uploads
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists() });
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.summary() });
        queryClient.invalidateQueries({ queryKey: progressKeys.list() });
      }, 1000);

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
        queryClient.setQueryData(progressKeys.list(), context.previousOperations);
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
      await queryClient.cancelQueries({ queryKey: knowledgeKeys.summary() });

      // Snapshot the previous values
      const previousItem = queryClient.getQueryData<KnowledgeItem>(knowledgeKeys.detail(sourceId));
      const previousSummaries = queryClient.getQueriesData({ queryKey: knowledgeKeys.summary() });

      // Optimistically update the detail item
      if (previousItem) {
        const updatedItem = { ...previousItem };

        // Initialize metadata if missing
        const currentMetadata = updatedItem.metadata || {};

        // Handle title updates
        if ('title' in updates && typeof updates.title === 'string') {
          updatedItem.title = updates.title;
        }

        // Handle tags updates
        if ('tags' in updates && Array.isArray(updates.tags)) {
          const newTags = updates.tags as string[];
          (updatedItem as any).tags = newTags;
        }

        // Handle knowledge_type updates
        if ('knowledge_type' in updates && typeof updates.knowledge_type === 'string') {
          const newType = updates.knowledge_type as "technical" | "business";
          updatedItem.knowledge_type = newType;
        }

        // Synchronize metadata with top-level fields
        updatedItem.metadata = {
          ...currentMetadata,
          ...((updatedItem as any).tags && { tags: (updatedItem as any).tags }),
          ...(updatedItem.knowledge_type && { knowledge_type: updatedItem.knowledge_type }),
        };

        queryClient.setQueryData<KnowledgeItem>(knowledgeKeys.detail(sourceId), updatedItem);
      }

      // Optimistically update summaries cache
      queryClient.setQueriesData<KnowledgeItemsResponse>({ queryKey: knowledgeKeys.summary() }, (old) => {
        if (!old?.items) return old;

        return {
          ...old,
          items: old.items.map((item) => {
            if (item.source_id === sourceId) {
              const updatedItem = { ...item };

              // Initialize metadata if missing
              const currentMetadata = updatedItem.metadata || {};

              // Update title if provided
              if ('title' in updates && typeof updates.title === 'string') {
                updatedItem.title = updates.title;
              }

              // Update tags if provided
              if ('tags' in updates && Array.isArray(updates.tags)) {
                const newTags = updates.tags as string[];
                updatedItem.tags = newTags;
              }

              // Update knowledge_type if provided
              if ('knowledge_type' in updates && typeof updates.knowledge_type === 'string') {
                const newType = updates.knowledge_type as "technical" | "business";
                updatedItem.knowledge_type = newType;
              }

              // Synchronize metadata with top-level fields
              updatedItem.metadata = {
                ...currentMetadata,
                ...(updatedItem.tags && { tags: updatedItem.tags }),
                ...(updatedItem.knowledge_type && { knowledge_type: updatedItem.knowledge_type }),
              };

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
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.summary() }); // Add summaries cache
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

      // Check if any completed operations are uploads (they complete faster)
      const hasCompletedUpload = completedOps.some((op) => op.operation_type === "upload" || op.type === "upload");

      // Use shorter delay for uploads (1s) vs crawls (5s) to handle fast operations
      const delay = hasCompletedUpload ? 1000 : 5000;

      // Invalidate after a delay to allow backend database to become consistent
      const timer = setTimeout(() => {
        // Invalidate all summaries regardless of filter
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.summary() });
        // Also invalidate lists for consistency
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists() });

        // For uploads, also refetch immediately to ensure UI shows the item
        if (hasCompletedUpload) {
          queryClient.refetchQueries({ queryKey: knowledgeKeys.summary() });
        }
      }, delay);

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
