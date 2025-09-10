/**
 * Credentials Service
 *
 * ⚠️  MIGRATION NOTICE ⚠️
 *
 * This service has been partially migrated to use the providers_clean system:
 *
 * ✅ STILL SUPPORTED:
 * - App settings management (RAG settings, performance settings, etc.)
 * - Non-API key credentials
 *
 * 🚨 DEPRECATED (will be removed):
 * - API key management methods (getAllCredentials, getCredentialsByCategory)
 * - Any methods related to LLM provider API keys
 *
 * 🔄 MIGRATE TO:
 * - API key management: Use cleanProviderService
 * - Provider management: Use cleanProviderService
 * - Model configuration: Use cleanProviderService.updateModelConfig()
 *
 * The providers_clean system provides:
 * - Encrypted API key storage
 * - Better provider management
 * - Model configuration per service
 * - Usage tracking and cost monitoring
 */

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

  // Legacy compatibility methods - DEPRECATED
  // These methods are deprecated and will be removed in a future version
  // Use the providers_clean API for all API key management

  /** @deprecated Use cleanProviderService.getActiveProviders() instead */
  async getAllCredentials(): Promise<Credential[]> {
    console.warn(
      "🚨 DEPRECATED: getAllCredentials() is deprecated and will be removed."
    );
    console.warn(
      "   Use cleanProviderService.getActiveProviders() for API key management."
    );
    console.warn("   Use credentialsService for app settings only.");
    return [];
  }

  /** @deprecated Use cleanProviderService for API keys, app-settings for other settings */
  async getCredentialsByCategory(category: string): Promise<Credential[]> {
    console.warn(
      `🚨 DEPRECATED: getCredentialsByCategory(${category}) is deprecated and will be removed.`
    );
    console.warn(
      "   For API keys: Use cleanProviderService.getActiveProviders()"
    );
    console.warn(
      "   For app settings: Use /api/app-settings endpoints directly"
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
      // Send individual requests for each setting since there's no bulk endpoint
      const updatePromises = Object.entries(settings).map(
        async ([key, value]) => {
          const url = new URL(`${this.baseUrl}/api/app-settings/${key}`);
          url.searchParams.append("value", String(value));

          const response = await fetch(url.toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(
              `Failed to update setting ${key}: ${response.status} ${response.statusText}`,
              errorText
            );
            throw new Error(`Failed to update ${key}: ${response.status}`);
          }

          return response.json();
        }
      );

      // Wait for all updates to complete
      await Promise.all(updatePromises);

      return true;
    } catch (error) {
      console.error("Failed to update RAG settings:", error);
      return false;
    }
  }

  async getCodeExtractionSettings(): Promise<{
    MIN_CODE_BLOCK_LENGTH: number;
    MAX_CODE_BLOCK_LENGTH: number;
    ENABLE_COMPLETE_BLOCK_DETECTION: boolean;
    ENABLE_LANGUAGE_SPECIFIC_PATTERNS: boolean;
    ENABLE_PROSE_FILTERING: boolean;
    MAX_PROSE_RATIO: number;
    MIN_CODE_INDICATORS: number;
    ENABLE_DIAGRAM_FILTERING: boolean;
    ENABLE_CONTEXTUAL_LENGTH: boolean;
    CODE_EXTRACTION_MAX_WORKERS: number;
    CONTEXT_WINDOW_SIZE: number;
    ENABLE_CODE_SUMMARIES: boolean;
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/app-settings`);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch code extraction settings: ${response.status}`
        );
      }

      const settings = await response.json();

      // Convert string values to appropriate types
      return {
        MIN_CODE_BLOCK_LENGTH: toInt(settings.MIN_CODE_BLOCK_LENGTH, 250),
        MAX_CODE_BLOCK_LENGTH: toInt(settings.MAX_CODE_BLOCK_LENGTH, 5000),
        ENABLE_COMPLETE_BLOCK_DETECTION: toBool(
          settings.ENABLE_COMPLETE_BLOCK_DETECTION,
          true
        ),
        ENABLE_LANGUAGE_SPECIFIC_PATTERNS: toBool(
          settings.ENABLE_LANGUAGE_SPECIFIC_PATTERNS,
          true
        ),
        ENABLE_PROSE_FILTERING: toBool(settings.ENABLE_PROSE_FILTERING, true),
        MAX_PROSE_RATIO: toFloat(settings.MAX_PROSE_RATIO, 0.15),
        MIN_CODE_INDICATORS: toInt(settings.MIN_CODE_INDICATORS, 3),
        ENABLE_DIAGRAM_FILTERING: toBool(
          settings.ENABLE_DIAGRAM_FILTERING,
          true
        ),
        ENABLE_CONTEXTUAL_LENGTH: toBool(
          settings.ENABLE_CONTEXTUAL_LENGTH,
          true
        ),
        CODE_EXTRACTION_MAX_WORKERS: toInt(
          settings.CODE_EXTRACTION_MAX_WORKERS,
          3
        ),
        CONTEXT_WINDOW_SIZE: toInt(settings.CONTEXT_WINDOW_SIZE, 1000),
        ENABLE_CODE_SUMMARIES: toBool(settings.ENABLE_CODE_SUMMARIES, true),
      };
    } catch (error) {
      console.error("Failed to fetch code extraction settings:", error);
      // Return sensible defaults on error
      return {
        MIN_CODE_BLOCK_LENGTH: 250,
        MAX_CODE_BLOCK_LENGTH: 5000,
        ENABLE_COMPLETE_BLOCK_DETECTION: true,
        ENABLE_LANGUAGE_SPECIFIC_PATTERNS: true,
        ENABLE_PROSE_FILTERING: true,
        MAX_PROSE_RATIO: 0.15,
        MIN_CODE_INDICATORS: 3,
        ENABLE_DIAGRAM_FILTERING: true,
        ENABLE_CONTEXTUAL_LENGTH: true,
        CODE_EXTRACTION_MAX_WORKERS: 3,
        CONTEXT_WINDOW_SIZE: 1000,
        ENABLE_CODE_SUMMARIES: true,
      };
    }
  }

  async updateCodeExtractionSettings(settings: {
    MIN_CODE_BLOCK_LENGTH: number;
    MAX_CODE_BLOCK_LENGTH: number;
    ENABLE_COMPLETE_BLOCK_DETECTION: boolean;
    ENABLE_LANGUAGE_SPECIFIC_PATTERNS: boolean;
    ENABLE_PROSE_FILTERING: boolean;
    MAX_PROSE_RATIO: number;
    MIN_CODE_INDICATORS: number;
    ENABLE_DIAGRAM_FILTERING: boolean;
    ENABLE_CONTEXTUAL_LENGTH: boolean;
    CODE_EXTRACTION_MAX_WORKERS: number;
    CONTEXT_WINDOW_SIZE: number;
    ENABLE_CODE_SUMMARIES: boolean;
  }): Promise<boolean> {
    try {
      // Send individual requests for each code extraction setting
      const updatePromises = Object.entries(settings).map(
        async ([key, value]) => {
          const url = new URL(`${this.baseUrl}/api/app-settings/${key}`);
          url.searchParams.append("value", String(value));

          const response = await fetch(url.toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(
              `Failed to update code extraction setting ${key}: ${response.status} ${response.statusText}`,
              errorText
            );
            throw new Error(`Failed to update ${key}: ${response.status}`);
          }

          return response.json();
        }
      );

      // Wait for all updates to complete
      await Promise.all(updatePromises);

      return true;
    } catch (error) {
      console.error("Failed to update code extraction settings:", error);
      return false;
    }
  }
}

export const credentialsService = new CredentialsService();
