import { toBool, toInt, toFloat } from "@/utils/typeConverters";

export interface Credential {
  id?: string;
  key: string;
  value?: string;
  encrypted_value?: string;
  is_encrypted: boolean;
  category: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RagSettings {
  USE_CONTEXTUAL_EMBEDDINGS: boolean;
  CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: number;
  USE_HYBRID_SEARCH: boolean;
  USE_AGENTIC_RAG: boolean;
  USE_RERANKING: boolean;
  MODEL_CHOICE: string;
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  EMBEDDING_MODEL?: string;
  // Crawling Performance Settings
  CRAWL_BATCH_SIZE?: number;
  CRAWL_MAX_CONCURRENT?: number;
  CRAWL_WAIT_STRATEGY?: string;
  CRAWL_PAGE_TIMEOUT?: number;
  CRAWL_DELAY_BEFORE_HTML?: number;
  // Storage Performance Settings
  DOCUMENT_STORAGE_BATCH_SIZE?: number;
  EMBEDDING_BATCH_SIZE?: number;
  DELETE_BATCH_SIZE?: number;
  ENABLE_PARALLEL_BATCHES?: boolean;
  // Advanced Settings
  MEMORY_THRESHOLD_PERCENT?: number;
  DISPATCHER_CHECK_INTERVAL?: number;
  CODE_EXTRACTION_BATCH_SIZE?: number;
  CODE_SUMMARY_MAX_WORKERS?: number;
}

class CredentialsService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = import.meta.env.VITE_API_URL || "http://localhost:8181";
  }

  async getCredential(
    key: string
  ): Promise<{ key: string; value?: string; is_encrypted?: boolean }> {
    try {
      // Get from app settings API
      const response = await fetch(`${this.baseUrl}/api/app-settings`);
      if (!response.ok) {
        return { key, value: undefined };
      }
      const settings = await response.json();
      return { key, value: settings[key], is_encrypted: false };
    } catch (error) {
      console.warn(`Failed to fetch credential ${key}:`, error);
      return { key, value: undefined };
    }
  }

  async getRagSettings(): Promise<RagSettings> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/app-settings/rag-strategy`
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch RAG settings: ${response.status}`);
      }

      const settings = await response.json();

      // Convert string values to appropriate types
      return {
        USE_CONTEXTUAL_EMBEDDINGS: toBool(
          settings.USE_CONTEXTUAL_EMBEDDINGS,
          false
        ),
        CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: toInt(
          settings.CONTEXTUAL_EMBEDDINGS_MAX_WORKERS,
          3
        ),
        USE_HYBRID_SEARCH: toBool(settings.USE_HYBRID_SEARCH, true),
        USE_AGENTIC_RAG: toBool(settings.USE_AGENTIC_RAG, true),
        USE_RERANKING: toBool(settings.USE_RERANKING, false),
        MODEL_CHOICE: settings.MODEL_CHOICE || "",
        LLM_PROVIDER: settings.LLM_PROVIDER || "",
        LLM_BASE_URL: settings.LLM_BASE_URL || "",
        EMBEDDING_MODEL: settings.EMBEDDING_MODEL || "",
        // Crawling Performance Settings
        CRAWL_BATCH_SIZE: toInt(settings.CRAWL_BATCH_SIZE, 5),
        CRAWL_MAX_CONCURRENT: toInt(settings.CRAWL_MAX_CONCURRENT, 3),
        CRAWL_WAIT_STRATEGY: settings.CRAWL_WAIT_STRATEGY || "adaptive",
        CRAWL_PAGE_TIMEOUT: toInt(settings.CRAWL_PAGE_TIMEOUT, 30000),
        CRAWL_DELAY_BEFORE_HTML: toFloat(settings.CRAWL_DELAY_BEFORE_HTML, 1),
        // Storage Performance Settings
        DOCUMENT_STORAGE_BATCH_SIZE: toInt(
          settings.DOCUMENT_STORAGE_BATCH_SIZE,
          50
        ),
        EMBEDDING_BATCH_SIZE: toInt(settings.EMBEDDING_BATCH_SIZE, 100),
        DELETE_BATCH_SIZE: toInt(settings.DELETE_BATCH_SIZE, 50),
        ENABLE_PARALLEL_BATCHES: toBool(settings.ENABLE_PARALLEL_BATCHES, true),
        // Advanced Settings
        MEMORY_THRESHOLD_PERCENT: toInt(settings.MEMORY_THRESHOLD_PERCENT, 80),
        DISPATCHER_CHECK_INTERVAL: toInt(
          settings.DISPATCHER_CHECK_INTERVAL,
          5000
        ),
        CODE_EXTRACTION_BATCH_SIZE: toInt(
          settings.CODE_EXTRACTION_BATCH_SIZE,
          10
        ),
        CODE_SUMMARY_MAX_WORKERS: toInt(settings.CODE_SUMMARY_MAX_WORKERS, 3),
      };
    } catch (error) {
      console.error("Failed to fetch RAG settings:", error);
      // Return sensible defaults on error
      return {
        USE_CONTEXTUAL_EMBEDDINGS: false,
        CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: 3,
        USE_HYBRID_SEARCH: true,
        USE_AGENTIC_RAG: true,
        USE_RERANKING: false,
        MODEL_CHOICE: "",
        LLM_PROVIDER: "",
        LLM_BASE_URL: "",
        EMBEDDING_MODEL: "",
        CRAWL_BATCH_SIZE: 5,
        CRAWL_MAX_CONCURRENT: 3,
        CRAWL_WAIT_STRATEGY: "adaptive",
        CRAWL_PAGE_TIMEOUT: 30000,
        CRAWL_DELAY_BEFORE_HTML: 1,
        DOCUMENT_STORAGE_BATCH_SIZE: 50,
        EMBEDDING_BATCH_SIZE: 100,
        DELETE_BATCH_SIZE: 50,
        ENABLE_PARALLEL_BATCHES: true,
        MEMORY_THRESHOLD_PERCENT: 80,
        DISPATCHER_CHECK_INTERVAL: 5000,
        CODE_EXTRACTION_BATCH_SIZE: 10,
        CODE_SUMMARY_MAX_WORKERS: 3,
      };
    }
  }

  // Legacy compatibility methods - now deprecated but kept for compatibility
  async getAllCredentials(): Promise<Credential[]> {
    console.warn("getAllCredentials is deprecated - use provider_clean API");
    return [];
  }

  async getCredentialsByCategory(category: string): Promise<Credential[]> {
    console.warn(
      `getCredentialsByCategory(${category}) is deprecated - use provider_clean API or app-settings`
    );

    if (category === "rag_strategy") {
      try {
        const settings = await this.getRagSettings();
        // Convert settings to credential format for compatibility
        return Object.entries(settings).map(([key, value]) => ({
          key,
          value: String(value),
          is_encrypted: false,
          category: "rag_strategy",
        }));
      } catch (error) {
        console.warn(`Failed to fetch rag_strategy settings:`, error);
        return [];
      }
    }

    return [];
  }

  async setCredential(key: string, value: unknown): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/app-settings/${key}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value }),
      });
      return response.ok;
    } catch (error) {
      console.error(`Failed to set credential ${key}:`, error);
      return false;
    }
  }

  async updateRagSettings(settings: Partial<RagSettings>): Promise<boolean> {
    try {
      // Update each setting individually
      const updates = Object.entries(settings).map(([key, value]) =>
        fetch(`${this.baseUrl}/api/app-settings/${key}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ value }),
        })
      );

      const results = await Promise.all(updates);
      return results.every((r) => r.ok);
    } catch (error) {
      console.error("Failed to update RAG settings:", error);
      return false;
    }
  }

  async getCodeExtractionSettings(): Promise<{
    CODE_EXTRACTION_BATCH_SIZE: number;
    CODE_SUMMARY_MAX_WORKERS: number;
  }> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/app-settings/code-extraction`
      );
      if (!response.ok) {
        throw new Error(
          `Failed to fetch code extraction settings: ${response.status}`
        );
      }

      const settings = await response.json();

      // Convert string values to appropriate types
      return {
        CODE_EXTRACTION_BATCH_SIZE: toInt(
          settings.CODE_EXTRACTION_BATCH_SIZE,
          10
        ),
        CODE_SUMMARY_MAX_WORKERS: toInt(settings.CODE_SUMMARY_MAX_WORKERS, 3),
      };
    } catch (error) {
      console.error("Failed to fetch code extraction settings:", error);
      // Return sensible defaults on error
      return {
        CODE_EXTRACTION_BATCH_SIZE: 10,
        CODE_SUMMARY_MAX_WORKERS: 3,
      };
    }
  }
}

export const credentialsService = new CredentialsService();
