/**
 * Inspector Pagination Hook
 * Handles pagination for the Knowledge Inspector with "Load More" functionality
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { STALE_TIMES } from "@/features/shared/queryPatterns";
import { knowledgeKeys } from "../../hooks/useKnowledgeQueries";
import { knowledgeService } from "../../services";
import type { ChunksResponse, CodeExample, CodeExamplesResponse, DocumentChunk } from "../../types";

export interface UseInspectorPaginationProps {
  sourceId: string;
  viewMode: "documents" | "code";
  searchQuery: string;
}

export interface UseInspectorPaginationResult {
  items: (DocumentChunk | CodeExample)[];
  isLoading: boolean;
  hasNextPage: boolean;
  fetchNextPage: (options?: any) => Promise<any>;
  isFetchingNextPage: boolean;
  totalCount: number;
  loadedCount: number;
}

export function useInspectorPagination({
  sourceId,
  viewMode,
  searchQuery,
}: UseInspectorPaginationProps): UseInspectorPaginationResult {
  const PAGE_SIZE = 100;

  // Use infinite query for the current view mode
  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery<
    ChunksResponse | CodeExamplesResponse,
    Error
  >({
    queryKey: [
      ...knowledgeKeys.detail(sourceId),
      viewMode === "documents" ? "chunks-infinite" : "code-examples-infinite",
    ],
    queryFn: ({ pageParam }: { pageParam: unknown }) => {
      const page = Number(pageParam) || 0;
      const service =
        viewMode === "documents" ? knowledgeService.getKnowledgeItemChunks : knowledgeService.getCodeExamples;

      return service(sourceId, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
    },
    getNextPageParam: (lastPage, allPages) => {
      const hasMore = (lastPage as ChunksResponse | CodeExamplesResponse)?.has_more;
      return hasMore ? allPages.length : undefined;
    },
    enabled: !!sourceId,
    staleTime: STALE_TIMES.normal,
    initialPageParam: 0,
  });

  // Flatten the paginated data and apply search filtering
  const { items, totalCount, loadedCount } = useMemo(() => {
    type Page = ChunksResponse | CodeExamplesResponse;
    if (!data || !data.pages) {
      return { items: [], totalCount: 0, loadedCount: 0 };
    }

    // Flatten all pages - data has 'pages' property from useInfiniteQuery
    const pages = data.pages as Page[];
    const allItems = pages.flatMap((page): (DocumentChunk | CodeExample)[] =>
      "chunks" in page ? (page.chunks ?? []) : "code_examples" in page ? (page.code_examples ?? []) : [],
    );

    // Get total from first page (fallback to loadedCount)
    const first = pages[0];
    const totalCount = first && "total" in first && typeof first.total === "number" ? first.total : allItems.length;
    const loadedCount = allItems.length;

    // Apply search filtering
    if (!searchQuery) {
      return { items: allItems, totalCount, loadedCount };
    }

    const query = searchQuery.toLowerCase();
    const filteredItems = allItems.filter((item: DocumentChunk | CodeExample) => {
      if (viewMode === "documents") {
        const doc = item as DocumentChunk;
        return (
          doc.content?.toLowerCase().includes(query) ||
          doc.title?.toLowerCase().includes(query) ||
          doc.metadata?.title?.toLowerCase().includes(query) ||
          doc.metadata?.section?.toLowerCase().includes(query)
        );
      } else {
        const code = item as CodeExample;
        return (
          code.content?.toLowerCase().includes(query) ||
          code.summary?.toLowerCase().includes(query) ||
          code.language?.toLowerCase().includes(query) ||
          code.file_path?.toLowerCase().includes(query) ||
          code.title?.toLowerCase().includes(query)
        );
      }
    });

    return { items: filteredItems, totalCount, loadedCount };
  }, [data, viewMode, searchQuery]);

  return {
    items,
    isLoading,
    hasNextPage: !!hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    totalCount,
    loadedCount,
  };
}
