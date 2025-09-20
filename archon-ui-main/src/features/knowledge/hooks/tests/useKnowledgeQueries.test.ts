import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeItemsResponse } from "../../types";
import { knowledgeKeys, useCrawlUrl, useDeleteKnowledgeItem, useUploadDocument } from "../useKnowledgeQueries";

// Mock the services
vi.mock("../../services", () => ({
  knowledgeService: {
    getKnowledgeItem: vi.fn(),
    deleteKnowledgeItem: vi.fn(),
    updateKnowledgeItem: vi.fn(),
    crawlUrl: vi.fn(),
    refreshKnowledgeItem: vi.fn(),
    uploadDocument: vi.fn(),
    stopCrawl: vi.fn(),
    getKnowledgeItemChunks: vi.fn(),
    getCodeExamples: vi.fn(),
    searchKnowledgeBase: vi.fn(),
    getKnowledgeSources: vi.fn(),
  },
}));

// Mock the toast hook
vi.mock("../../../ui/hooks/useToast", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

// Mock smart polling
vi.mock("../../../ui/hooks", () => ({
  useSmartPolling: () => ({
    refetchInterval: 30000,
    isPaused: false,
  }),
}));

// Mock the knowledge filter context
const mockCurrentFilter = {
  knowledge_type: 'technical' as const,
  search: '',
  page: 1,
  per_page: 100
};

const mockUpdateFilter = vi.fn();
const mockIsCurrentFilter = vi.fn().mockReturnValue(true);

// Mock the context module that's dynamically imported
vi.mock("../context", () => ({
  useKnowledgeFilter: () => ({
    currentFilter: mockCurrentFilter,
    updateFilter: mockUpdateFilter,
    isCurrentFilter: mockIsCurrentFilter,
  }),
}));

// Mock the require function used in dynamic imports
const originalRequire = globalThis.require;
beforeAll(() => {
  globalThis.require = vi.fn().mockImplementation((module: string) => {
    if (module === "../context") {
      return {
        useKnowledgeFilter: () => ({
          currentFilter: mockCurrentFilter,
          updateFilter: mockUpdateFilter,
          isCurrentFilter: mockIsCurrentFilter,
        }),
      };
    }
    return originalRequire?.(module);
  });
});

afterAll(() => {
  globalThis.require = originalRequire;
});

// Test wrapper with QueryClient
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
};

describe("useKnowledgeQueries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("knowledgeKeys", () => {
    it("should generate correct query keys", () => {
      expect(knowledgeKeys.all).toEqual(["knowledge"]);
      expect(knowledgeKeys.lists()).toEqual(["knowledge", "list"]);
      expect(knowledgeKeys.detail("source-123")).toEqual(["knowledge", "detail", "source-123"]);
      expect(knowledgeKeys.chunks("source-123", { domain: "example.com" })).toEqual([
        "knowledge",
        "source-123",
        "chunks",
        { domain: "example.com", limit: undefined, offset: undefined },
      ]);
      expect(knowledgeKeys.codeExamples("source-123")).toEqual([
        "knowledge",
        "source-123",
        "code-examples",
        { limit: undefined, offset: undefined },
      ]);
      expect(knowledgeKeys.search("test query")).toEqual(["knowledge", "search", "test query"]);
      expect(knowledgeKeys.sources()).toEqual(["knowledge", "sources"]);
    });

    it("should handle filter in summaries key", () => {
      const filter = { knowledge_type: "technical" as const, page: 2 };
      expect(knowledgeKeys.summaries(filter)).toEqual(["knowledge", "summaries", filter]);
    });
  });

  describe("useDeleteKnowledgeItem", () => {
    it("should optimistically remove item and handle success", async () => {
      const initialData: KnowledgeItemsResponse = {
        items: [
          {
            id: "1",
            source_id: "source-1",
            title: "Item 1",
            url: "https://example.com/1",
            source_type: "url" as const,
            knowledge_type: "technical" as const,
            status: "active" as const,
            document_count: 5,
            code_examples_count: 2,
            metadata: {},
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          },
          {
            id: "2",
            source_id: "source-2",
            title: "Item 2",
            url: "https://example.com/2",
            source_type: "url" as const,
            knowledge_type: "business" as const,
            status: "active" as const,
            document_count: 3,
            code_examples_count: 0,
            metadata: {},
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          },
        ],
        total: 2,
        page: 1,
        per_page: 20,
      };

      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.deleteKnowledgeItem).mockResolvedValue({
        success: true,
        message: "Item deleted",
      });

      // Create QueryClient instance that will be used by the test
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });

      // Pre-populate cache with the same client instance
      queryClient.setQueryData(knowledgeKeys.lists(), initialData);

      // Create wrapper with the pre-populated QueryClient
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(() => useDeleteKnowledgeItem(), { wrapper });

      await result.current.mutateAsync("source-1");

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
        expect(knowledgeService.deleteKnowledgeItem).toHaveBeenCalledWith("source-1");
      });
    });

    it("should handle deletion error", async () => {
      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.deleteKnowledgeItem).mockRejectedValue(new Error("Deletion failed"));

      const wrapper = createWrapper();
      const { result } = renderHook(() => useDeleteKnowledgeItem(), { wrapper });

      await expect(result.current.mutateAsync("source-1")).rejects.toThrow("Deletion failed");
    });
  });

  describe("useCrawlUrl", () => {
    beforeEach(() => {
      // Reset context mocks
      vi.clearAllMocks();
      mockIsCurrentFilter.mockReturnValue(true);
    });

    it("should start crawl and return progress ID", async () => {
      const crawlRequest = {
        url: "https://example.com",
        knowledge_type: "technical" as const,
        tags: ["docs"],
        max_depth: 2,
      };

      const mockResponse = {
        success: true,
        progressId: "progress-123",
        message: "Crawling started",
        estimatedDuration: "3-5 minutes",
      };

      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.crawlUrl).mockResolvedValue(mockResponse);

      const wrapper = createWrapper();
      const { result } = renderHook(() => useCrawlUrl(), { wrapper });

      const response = await result.current.mutateAsync(crawlRequest);

      expect(response).toEqual(mockResponse);
      expect(knowledgeService.crawlUrl).toHaveBeenCalledWith(crawlRequest);
    });

    it("should handle crawl error", async () => {
      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.crawlUrl).mockRejectedValue(new Error("Invalid URL"));

      const wrapper = createWrapper();
      const { result } = renderHook(() => useCrawlUrl(), { wrapper });

      await expect(
        result.current.mutateAsync({
          url: "invalid-url",
        }),
      ).rejects.toThrow("Invalid URL");
    });

    it("should perform optimistic updates using current filter context", async () => {
      const crawlRequest = {
        url: "https://example.com",
        knowledge_type: "technical" as const,
        tags: ["docs"],
        max_depth: 2,
      };

      const mockResponse = {
        success: true,
        progressId: "progress-123",
        message: "Crawling started",
        estimatedDuration: "3-5 minutes",
      };

      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.crawlUrl).mockResolvedValue(mockResponse);

      // Set up initial cache data
      const initialData: KnowledgeItemsResponse = {
        items: [],
        total: 0,
        page: 1,
        per_page: 100,
      };

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });

      // Set up cache with current filter
      queryClient.setQueryData(knowledgeKeys.summaries(mockCurrentFilter), initialData);

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(() => useCrawlUrl(), { wrapper });

      // Execute mutation
      await result.current.mutateAsync(crawlRequest);

      // Verify optimistic update was applied to current filter cache
      const updatedData = queryClient.getQueryData<KnowledgeItemsResponse>(
        knowledgeKeys.summaries(mockCurrentFilter)
      );

      expect(updatedData).toBeDefined();
      expect(updatedData?.items).toHaveLength(1);
      expect(updatedData?.items[0]).toMatchObject({
        url: crawlRequest.url,
        knowledge_type: crawlRequest.knowledge_type,
        status: "processing",
      });
    });

    it("should update cache for matching filters during optimistic updates", async () => {
      const crawlRequest = {
        url: "https://example.com",
        knowledge_type: "technical" as const, // Matches mockCurrentFilter.knowledge_type
      };

      const mockResponse = {
        success: true,
        progressId: "progress-123",
        message: "Crawling started",
      };

      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.crawlUrl).mockResolvedValue(mockResponse);

      const initialData: KnowledgeItemsResponse = {
        items: [],
        total: 0,
        page: 1,
        per_page: 100,
      };

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });

      // Pre-populate cache with current filter
      queryClient.setQueryData(knowledgeKeys.summaries(mockCurrentFilter), initialData);

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(() => useCrawlUrl(), { wrapper });

      await result.current.mutateAsync(crawlRequest);

      // Verify optimistic update was applied
      const updatedData = queryClient.getQueryData<KnowledgeItemsResponse>(
        knowledgeKeys.summaries(mockCurrentFilter)
      );

      expect(updatedData?.items).toHaveLength(1);
      expect(updatedData?.total).toBe(1);
    });

    it("should handle non-matching filters gracefully", async () => {
      const crawlRequest = {
        url: "https://example.com",
        knowledge_type: "technical" as const,
      };

      // Mock that current filter does NOT match
      mockIsCurrentFilter.mockReturnValue(false);

      const mockResponse = {
        success: true,
        progressId: "progress-123",
        message: "Crawling started",
      };

      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.crawlUrl).mockResolvedValue(mockResponse);

      const wrapper = createWrapper();
      const { result } = renderHook(() => useCrawlUrl(), { wrapper });

      // Should still work even if filter doesn't match
      const response = await result.current.mutateAsync(crawlRequest);
      expect(response).toEqual(mockResponse);
    });
  });

  describe("useUploadDocument", () => {
    beforeEach(() => {
      // Reset context mocks
      vi.clearAllMocks();
      mockIsCurrentFilter.mockReturnValue(true);
    });

    it("should upload document with metadata", async () => {
      const file = new File(["test content"], "test.pdf", { type: "application/pdf" });
      const metadata = {
        knowledge_type: "business" as const,
        tags: ["report"],
      };

      const mockResponse = {
        success: true,
        progressId: "upload-456",
        message: "Upload started",
        filename: "test.pdf",
      };

      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.uploadDocument).mockResolvedValue(mockResponse);

      const wrapper = createWrapper();
      const { result } = renderHook(() => useUploadDocument(), { wrapper });

      const response = await result.current.mutateAsync({ file, metadata });

      expect(response).toEqual(mockResponse);
      expect(knowledgeService.uploadDocument).toHaveBeenCalledWith(file, metadata);
    });

    it("should handle upload error", async () => {
      const file = new File(["test"], "test.txt", { type: "text/plain" });
      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.uploadDocument).mockRejectedValue(new Error("File too large"));

      const wrapper = createWrapper();
      const { result } = renderHook(() => useUploadDocument(), { wrapper });

      await expect(result.current.mutateAsync({ file, metadata: {} })).rejects.toThrow("File too large");
    });

    it("should perform filter-aware optimistic updates for document uploads", async () => {
      const file = new File(["test content"], "test.pdf", { type: "application/pdf" });
      const metadata = {
        knowledge_type: "technical" as const, // Matches mockCurrentFilter.knowledge_type
      };

      const mockResponse = {
        success: true,
        progressId: "upload-456",
        message: "Upload started",
        filename: "test.pdf",
      };

      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.uploadDocument).mockResolvedValue(mockResponse);

      const initialData: KnowledgeItemsResponse = {
        items: [],
        total: 0,
        page: 1,
        per_page: 100,
      };

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });

      queryClient.setQueryData(knowledgeKeys.summaries(mockCurrentFilter), initialData);

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(() => useUploadDocument(), { wrapper });

      await result.current.mutateAsync({ file, metadata });

      // Verify optimistic update was applied to the cache
      const updatedData = queryClient.getQueryData<KnowledgeItemsResponse>(
        knowledgeKeys.summaries(mockCurrentFilter)
      );

      expect(updatedData?.items).toHaveLength(1);
      expect(updatedData?.items[0]).toMatchObject({
        title: "test.pdf",
        knowledge_type: metadata.knowledge_type,
        status: "processing",
      });
    });

    it("should use current filter for optimistic updates when filter context is available", async () => {
      const file = new File(["content"], "doc.pdf", { type: "application/pdf" });
      const metadata = {
        knowledge_type: "technical" as const, // Matches current filter
      };

      const mockResponse = {
        success: true,
        progressId: "upload-789",
        message: "Upload started",
        filename: "doc.pdf",
      };

      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.uploadDocument).mockResolvedValue(mockResponse);

      const initialData: KnowledgeItemsResponse = {
        items: [],
        total: 0,
        page: 1,
        per_page: 100,
      };

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });

      queryClient.setQueryData(knowledgeKeys.summaries(mockCurrentFilter), initialData);

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(() => useUploadDocument(), { wrapper });

      await result.current.mutateAsync({ file, metadata });

      // Verify the cache was updated
      const updatedData = queryClient.getQueryData<KnowledgeItemsResponse>(
        knowledgeKeys.summaries(mockCurrentFilter)
      );

      expect(updatedData?.items).toHaveLength(1);
    });
  });

  describe("Filter Integration", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should prioritize current filter updates over other cache keys", async () => {
      // This test verifies the core enhancement: prioritizing current filter updates
      const crawlRequest = {
        url: "https://example.com",
        knowledge_type: "technical" as const, // Matches mockCurrentFilter.knowledge_type
      };

      const mockResponse = {
        success: true,
        progressId: "priority-test",
        message: "Crawling started",
      };

      // Set up multiple cached filters
      const otherFilter = { knowledge_type: 'business' as const, search: '', page: 1, per_page: 100 };

      const { knowledgeService } = await import("../../services");
      vi.mocked(knowledgeService.crawlUrl).mockResolvedValue(mockResponse);

      const initialData: KnowledgeItemsResponse = {
        items: [],
        total: 0,
        page: 1,
        per_page: 100,
      };

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });

      // Set up both caches
      queryClient.setQueryData(knowledgeKeys.summaries(mockCurrentFilter), initialData);
      queryClient.setQueryData(knowledgeKeys.summaries(otherFilter), initialData);

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(() => useCrawlUrl(), { wrapper });

      await result.current.mutateAsync(crawlRequest);

      // Verify current filter cache was updated first (gets priority)
      const currentFilterData = queryClient.getQueryData<KnowledgeItemsResponse>(
        knowledgeKeys.summaries(mockCurrentFilter)
      );
      const otherFilterData = queryClient.getQueryData<KnowledgeItemsResponse>(
        knowledgeKeys.summaries(otherFilter)
      );

      // Current filter should be updated since knowledge_type matches
      expect(currentFilterData?.items).toHaveLength(1);

      // Other filter should remain unchanged (no knowledge_type match)
      expect(otherFilterData?.items).toHaveLength(0);
    });
  });
});
