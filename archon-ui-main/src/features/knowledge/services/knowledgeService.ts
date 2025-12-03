/**
 * Knowledge Base Service
 * Handles all knowledge-related API operations using TanStack Query patterns
 */

import { callAPIWithETag } from "../../shared/api/apiClient";
import { APIServiceError } from "../../shared/types/errors";
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
  async getKnowledgeSummaries(filter?: KnowledgeItemsFilter): Promise<KnowledgeItemsResponse> {
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

    return callAPIWithETag<KnowledgeItemsResponse>(endpoint);
  },

  /**
   * Get a specific knowledge item
   */
  async getKnowledgeItem(sourceId: string): Promise<KnowledgeItem> {
    return callAPIWithETag<KnowledgeItem>(`/api/knowledge-items/${sourceId}`);
  },

  /**
   * Delete a knowledge item
   */
  async deleteKnowledgeItem(sourceId: string): Promise<{ success: boolean; message: string }> {
    const response = await callAPIWithETag<{ success: boolean; message: string }>(`/api/knowledge-items/${sourceId}`, {
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
  ): Promise<KnowledgeItem> {
    const response = await callAPIWithETag<KnowledgeItem>(`/api/knowledge-items/${sourceId}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });

    return response;
  },

  /**
   * Start crawling a URL
   */
  async crawlUrl(request: CrawlRequest): Promise<CrawlStartResponse> {
    const response = await callAPIWithETag<CrawlStartResponse>("/api/knowledge-items/crawl", {
      method: "POST",
      body: JSON.stringify(request),
    });

    return response;
  },

  /**
   * Refresh an existing knowledge item
   */
  async refreshKnowledgeItem(sourceId: string): Promise<RefreshResponse> {
    const response = await callAPIWithETag<RefreshResponse>(`/api/knowledge-items/${sourceId}/refresh`, {
      method: "POST",
    });

    return response;
  },

  /**
   * Upload a document with progress tracking
   * Uses XMLHttpRequest to get upload progress events
   */
  uploadDocumentWithProgress(
    file: File,
    metadata: UploadMetadata,
    onProgress?: (percent: number, stage: "uploading" | "processing") => void,
  ): Promise<{ success: boolean; progressId: string; message: string; filename: string }> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file);

      if (metadata.knowledge_type) {
        formData.append("knowledge_type", metadata.knowledge_type);
      }
      if (metadata.tags?.length) {
        formData.append("tags", JSON.stringify(metadata.tags));
      }

      // Build URL
      let uploadUrl = "/api/documents/upload";
      if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
        const testHost = process.env?.VITE_HOST || "localhost";
        const testPort = process.env?.ARCHON_SERVER_PORT || "8181";
        uploadUrl = `http://${testHost}:${testPort}${uploadUrl}`;
      }

      const xhr = new XMLHttpRequest();

      // Track upload progress (file transfer to server)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress(percent, "uploading");
        }
      };

      // Handle completion
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            // File uploaded, now server is processing
            onProgress?.(100, "processing");
            resolve(response);
          } catch {
            reject(new APIServiceError("Invalid JSON response", "PARSE_ERROR", xhr.status));
          }
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new APIServiceError(err.error || `HTTP ${xhr.status}`, "HTTP_ERROR", xhr.status));
          } catch {
            reject(new APIServiceError(`HTTP ${xhr.status}`, "HTTP_ERROR", xhr.status));
          }
        }
      };

      // Handle network errors
      xhr.onerror = () => {
        reject(new APIServiceError("Network error during upload", "NETWORK_ERROR", 0));
      };

      // Handle timeout
      xhr.ontimeout = () => {
        reject(new APIServiceError("Upload timed out", "TIMEOUT_ERROR", 0));
      };

      xhr.open("POST", uploadUrl, true);
      xhr.timeout = 600000; // 10 minute timeout for very large files
      xhr.send(formData);
    });
  },

  /**
   * Upload a document (simple version without progress)
   * @deprecated Use uploadDocumentWithProgress for better UX
   */
  async uploadDocument(
    file: File,
    metadata: UploadMetadata,
  ): Promise<{ success: boolean; progressId: string; message: string; filename: string }> {
    return this.uploadDocumentWithProgress(file, metadata);
  },

  /**
   * Stop a running crawl
   */
  async stopCrawl(progressId: string): Promise<{ success: boolean; message: string }> {
    return callAPIWithETag<{ success: boolean; message: string }>(`/api/knowledge-items/stop/${progressId}`, {
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

    return callAPIWithETag<ChunksResponse>(endpoint);
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

    return callAPIWithETag<CodeExamplesResponse>(endpoint);
  },

  /**
   * Search the knowledge base
   */
  async searchKnowledgeBase(options: SearchOptions): Promise<SearchResultsResponse> {
    return callAPIWithETag<SearchResultsResponse>("/api/knowledge-items/search", {
      method: "POST",
      body: JSON.stringify(options),
    });
  },

  /**
   * Get available knowledge sources
   */
  async getKnowledgeSources(): Promise<KnowledgeSource[]> {
    return callAPIWithETag<KnowledgeSource[]>("/api/knowledge-items/sources");
  },

  /**
   * Start re-embedding all documents with the current embedding model
   */
  async startReEmbed(): Promise<{ success: boolean; progressId: string; message: string }> {
    return callAPIWithETag<{ success: boolean; progressId: string; message: string }>(
      "/api/knowledge/re-embed",
      { method: "POST" }
    );
  },

  /**
   * Stop a running re-embed operation
   */
  async stopReEmbed(progressId: string): Promise<{ success: boolean; message: string }> {
    return callAPIWithETag<{ success: boolean; message: string }>(
      `/api/knowledge/re-embed/stop/${progressId}`,
      { method: "POST" }
    );
  },

  /**
   * Get statistics about documents that would be re-embedded
   */
  async getReEmbedStats(): Promise<{
    success: boolean;
    total_chunks: number;
    embedding_models_in_use: string[];
    estimated_time_seconds: number;
  }> {
    return callAPIWithETag<{
      success: boolean;
      total_chunks: number;
      embedding_models_in_use: string[];
      estimated_time_seconds: number;
    }>("/api/knowledge/re-embed/stats");
  },
};
