/**
 * Knowledge Base Service
 * Handles all knowledge-related API operations using TanStack Query patterns
 */

import { callAPIWithETag } from "../../shared/apiWithEtag";
import { APIServiceError } from "../../shared/errors";
import type {
  ChunksResponse,
  CodeExamplesResponse,
  CrawlRequest,
  CrawlStartResponse,
  KnowledgeItem,
  KnowledgeItemsFilter,
  KnowledgeItemsResponse,
  KnowledgeSource,
  RefreshResponse,
  SearchOptions,
  SearchResultsResponse,
  UploadMetadata,
} from "../types";

export const knowledgeService = {
  /**
   * Get lightweight summaries of knowledge items
   * Use this for card displays and frequent updates
   */
  async getKnowledgeSummaries(filter?: KnowledgeItemsFilter, signal?: AbortSignal): Promise<KnowledgeItemsResponse> {
    const params = new URLSearchParams();

    if (filter?.page) params.append("page", filter.page.toString());
    if (filter?.per_page) params.append("per_page", filter.per_page.toString());
    if (filter?.knowledge_type) params.append("knowledge_type", filter.knowledge_type);
    if (filter?.search) params.append("search", filter.search);
    if (filter?.tags?.length) {
      for (const tag of filter.tags) {
        params.append("tags", tag);
      }
    }

    const queryString = params.toString();
    const endpoint = `/api/knowledge-items/summary${queryString ? `?${queryString}` : ""}`;

    return callAPIWithETag<KnowledgeItemsResponse>(endpoint, { signal });
  },

  /**
   * Get a specific knowledge item
   */
  async getKnowledgeItem(sourceId: string, signal?: AbortSignal): Promise<KnowledgeItem> {
    return callAPIWithETag<KnowledgeItem>(`/api/knowledge-items/${sourceId}`, { signal });
  },

  /**
   * Delete a knowledge item
   */
  async deleteKnowledgeItem(sourceId: string, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
    const response = await callAPIWithETag<{ success: boolean; message: string }>(`/api/knowledge-items/${sourceId}`, {
      signal,
      method: "DELETE",
    });

    return response;
  },

  /**
   * Update a knowledge item
   */
  async updateKnowledgeItem(
    sourceId: string,
    updates: Partial<KnowledgeItem> & { tags?: string[] },
    signal?: AbortSignal,
  ): Promise<KnowledgeItem> {
    const response = await callAPIWithETag<KnowledgeItem>(`/api/knowledge-items/${sourceId}`, {
      signal,
      method: "PUT",
      body: JSON.stringify(updates),
    });

    return response;
  },

  /**
   * Start crawling a URL
   */
  async crawlUrl(request: CrawlRequest, signal?: AbortSignal): Promise<CrawlStartResponse> {
    const response = await callAPIWithETag<CrawlStartResponse>("/api/knowledge-items/crawl", {
      signal,
      method: "POST",
      body: JSON.stringify(request),
    });

    return response;
  },

  /**
   * Refresh an existing knowledge item
   */
  async refreshKnowledgeItem(sourceId: string, signal?: AbortSignal): Promise<RefreshResponse> {
    const response = await callAPIWithETag<RefreshResponse>(`/api/knowledge-items/${sourceId}/refresh`, {
      signal,
      method: "POST",
    });

    return response;
  },

  /**
   * Upload a document
   */
  async uploadDocument(
    file: File,
    metadata: UploadMetadata,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; progressId: string; message: string; filename: string }> {
    const formData = new FormData();
    formData.append("file", file);

    if (metadata.knowledge_type) {
      formData.append("knowledge_type", metadata.knowledge_type);
    }
    if (metadata.tags?.length) {
      formData.append("tags", JSON.stringify(metadata.tags));
    }

    // Use fetch directly for file upload (FormData doesn't work well with our ETag wrapper)
    // In test environment, we need absolute URLs
    let uploadUrl = "/api/documents/upload";
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
      const testHost = process.env?.VITE_HOST || "localhost";
      const testPort = process.env?.ARCHON_SERVER_PORT || "8181";
      uploadUrl = `http://${testHost}:${testPort}${uploadUrl}`;
    }

    const response = await fetch(uploadUrl, {
      method: "POST",
      body: formData,
      signal: signal ?? AbortSignal.timeout(30000), // 30 second timeout for file uploads
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new APIServiceError(err.error || `HTTP ${response.status}`, "HTTP_ERROR", response.status);
    }

    return response.json();
  },

  /**
   * Stop a running crawl
   */
  async stopCrawl(progressId: string, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
    return callAPIWithETag<{ success: boolean; message: string }>(`/api/knowledge-items/stop/${progressId}`, {
      signal,
      method: "POST",
    });
  },

  /**
   * Get document chunks for a knowledge item with pagination
   */
  async getKnowledgeItemChunks(
    sourceId: string,
    options?: {
      domainFilter?: string;
      limit?: number;
      offset?: number;
    },
    signal?: AbortSignal,
  ): Promise<ChunksResponse> {
    const params = new URLSearchParams();
    if (options?.domainFilter) {
      params.append("domain_filter", options.domainFilter);
    }
    if (options?.limit !== undefined) {
      params.append("limit", options.limit.toString());
    }
    if (options?.offset !== undefined) {
      params.append("offset", options.offset.toString());
    }

    const queryString = params.toString();
    const endpoint = `/api/knowledge-items/${sourceId}/chunks${queryString ? `?${queryString}` : ""}`;

    return callAPIWithETag<ChunksResponse>(endpoint, { signal });
  },

  /**
   * Get code examples for a knowledge item with pagination
   */
  async getCodeExamples(
    sourceId: string,
    options?: {
      limit?: number;
      offset?: number;
    },
    signal?: AbortSignal,
  ): Promise<CodeExamplesResponse> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) {
      params.append("limit", options.limit.toString());
    }
    if (options?.offset !== undefined) {
      params.append("offset", options.offset.toString());
    }

    const queryString = params.toString();
    const endpoint = `/api/knowledge-items/${sourceId}/code-examples${queryString ? `?${queryString}` : ""}`;

    return callAPIWithETag<CodeExamplesResponse>(endpoint, { signal });
  },

  /**
   * Search the knowledge base
   */
  async searchKnowledgeBase(options: SearchOptions, signal?: AbortSignal): Promise<SearchResultsResponse> {
    return callAPIWithETag<SearchResultsResponse>("/api/knowledge-items/search", {
      signal,
      method: "POST",
      body: JSON.stringify(options),
    });
  },

  /**
   * Get available knowledge sources
   */
  async getKnowledgeSources(signal?: AbortSignal): Promise<KnowledgeSource[]> {
    return callAPIWithETag<KnowledgeSource[]>("/api/knowledge-items/sources", { signal });
  },
};
