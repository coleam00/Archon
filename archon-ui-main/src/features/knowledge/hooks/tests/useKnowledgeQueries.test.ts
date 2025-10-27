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
vi.mock("@/features/shared/hooks/useToast", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

// Mock smart polling
vi.mock("@/features/shared/hooks", () => ({
  useSmartPolling: () => ({
    refetchInterval: 30000,
    isPaused: false,
  }),
}));

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
  });

  describe("useUploadDocument", () => {
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
  });
});
