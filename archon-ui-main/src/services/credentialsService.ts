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
  // Azure OpenAI specific settings
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_OPENAI_DEPLOYMENT?: string;
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

export interface CodeExtractionSettings {
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
}

import { getApiUrl } from "../config/api";

class CredentialsService {
  private baseUrl = getApiUrl();

  private handleCredentialError(error: any, context: string): Error {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for network errors
    if (
      errorMessage.toLowerCase().includes("network") ||
      errorMessage.includes("fetch") ||
      errorMessage.includes("Failed to fetch")
    ) {
      return new Error(
        `Network error while ${context.toLowerCase()}: ${errorMessage}. ` +
          `Please check your connection and server status.`,
      );
    }

    // Return original error with context
    return new Error(`${context} failed: ${errorMessage}`);
  }

  async getAllCredentials(): Promise<Credential[]> {
    const response = await fetch(`${this.baseUrl}/api/credentials`);
    if (!response.ok) {
      throw new Error("Failed to fetch credentials");
    }
    return response.json();
  }

  async getCredentialsByCategory(category: string): Promise<Credential[]> {
    const response = await fetch(
      `${this.baseUrl}/api/credentials/categories/${category}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch credentials for category: ${category}`);
    }
    const result = await response.json();

    // The API returns {credentials: {...}} where credentials is a dict
    // Convert to array format expected by frontend
    if (result.credentials && typeof result.credentials === "object") {
      return Object.entries(result.credentials).map(
        ([key, value]: [string, any]) => {
          if (value && typeof value === "object" && value.is_encrypted) {
            return {
              key,
              value: undefined,
              encrypted_value: value.encrypted_value,
              is_encrypted: true,
              category,
              description: value.description,
            };
          } else {
            return {
              key,
              value: value,
              encrypted_value: undefined,
              is_encrypted: false,
              category,
              description: "",
            };
          }
        },
      );
    }

    return [];
  }

  async getCredential(
    key: string,
  ): Promise<{ key: string; value?: string; is_encrypted?: boolean }> {
    const response = await fetch(`${this.baseUrl}/api/credentials/${key}`);
    if (!response.ok) {
      if (response.status === 404) {
        // Return empty object if credential not found
        return { key, value: undefined };
      }
      throw new Error(`Failed to fetch credential: ${key}`);
    }
    return response.json();
  }

  async getRagSettings(): Promise<RagSettings> {
    const ragCredentials = await this.getCredentialsByCategory("rag_strategy");
    const apiKeysCredentials = await this.getCredentialsByCategory("api_keys");

    const settings: RagSettings = {
      USE_CONTEXTUAL_EMBEDDINGS: false,
      CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: 3,
      USE_HYBRID_SEARCH: true,
      USE_AGENTIC_RAG: true,
      USE_RERANKING: true,
      MODEL_CHOICE: "gpt-4.1-nano",
      LLM_PROVIDER: "openai",
      LLM_BASE_URL: "",
      EMBEDDING_MODEL: "",
      // Azure OpenAI defaults
      AZURE_OPENAI_ENDPOINT: "",
      AZURE_OPENAI_DEPLOYMENT: "",
      // Crawling Performance Settings defaults
      CRAWL_BATCH_SIZE: 50,
      CRAWL_MAX_CONCURRENT: 10,
      CRAWL_WAIT_STRATEGY: "domcontentloaded",
      CRAWL_PAGE_TIMEOUT: 60000, // Increased from 30s to 60s for documentation sites
      CRAWL_DELAY_BEFORE_HTML: 0.5,
      // Storage Performance Settings defaults
      DOCUMENT_STORAGE_BATCH_SIZE: 50,
      EMBEDDING_BATCH_SIZE: 100,
      DELETE_BATCH_SIZE: 100,
      ENABLE_PARALLEL_BATCHES: true,
      // Advanced Settings defaults
      MEMORY_THRESHOLD_PERCENT: 80,
      DISPATCHER_CHECK_INTERVAL: 30,
      CODE_EXTRACTION_BATCH_SIZE: 50,
      CODE_SUMMARY_MAX_WORKERS: 3,
    };

    // Map credentials to settings
    [...ragCredentials, ...apiKeysCredentials].forEach((cred) => {
      if (cred.key in settings) {
        // String fields
        if (
          [
            "MODEL_CHOICE",
            "LLM_PROVIDER",
            "LLM_BASE_URL",
            "EMBEDDING_MODEL",
            "AZURE_OPENAI_ENDPOINT",
            "AZURE_OPENAI_DEPLOYMENT",
            "CRAWL_WAIT_STRATEGY",
          ].includes(cred.key)
        ) {
          (settings as any)[cred.key] = cred.value || "";
        }
        // Number fields
        else if (
          [
            "CONTEXTUAL_EMBEDDINGS_MAX_WORKERS",
            "CRAWL_BATCH_SIZE",
            "CRAWL_MAX_CONCURRENT",
            "CRAWL_PAGE_TIMEOUT",
            "DOCUMENT_STORAGE_BATCH_SIZE",
            "EMBEDDING_BATCH_SIZE",
            "DELETE_BATCH_SIZE",
            "MEMORY_THRESHOLD_PERCENT",
            "DISPATCHER_CHECK_INTERVAL",
            "CODE_EXTRACTION_BATCH_SIZE",
            "CODE_SUMMARY_MAX_WORKERS",
          ].includes(cred.key)
        ) {
          (settings as any)[cred.key] =
            parseInt(cred.value || "0", 10) || (settings as any)[cred.key];
        }
        // Float fields
        else if (cred.key === "CRAWL_DELAY_BEFORE_HTML") {
          settings[cred.key] = parseFloat(cred.value || "0.5") || 0.5;
        }
        // Boolean fields
        else {
          (settings as any)[cred.key] = cred.value === "true";
        }
      }
    });

    return settings;
  }

  async updateCredential(credential: Credential): Promise<Credential> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/credentials/${credential.key}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(credential),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return response.json();
    } catch (error) {
      throw this.handleCredentialError(
        error,
        `Updating credential '${credential.key}'`,
      );
    }
  }

  async createCredential(credential: Credential): Promise<Credential> {
    try {
      const response = await fetch(`${this.baseUrl}/api/credentials`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(credential),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return response.json();
    } catch (error) {
      throw this.handleCredentialError(
        error,
        `Creating credential '${credential.key}'`,
      );
    }
  }

  async deleteCredential(key: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/credentials/${key}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
    } catch (error) {
      throw this.handleCredentialError(error, `Deleting credential '${key}'`);
    }
  }

  async updateRagSettings(settings: RagSettings): Promise<void> {
    const promises = [];

    // Update all RAG strategy settings
    for (const [key, value] of Object.entries(settings)) {
      // Skip undefined values
      if (value === undefined) continue;

      promises.push(
        this.updateCredential({
          key,
          value: value.toString(),
          is_encrypted: false,
          category: "rag_strategy",
        }),
      );
    }

    await Promise.all(promises);
  }

  async getCodeExtractionSettings(): Promise<CodeExtractionSettings> {
    const codeExtractionCredentials =
      await this.getCredentialsByCategory("code_extraction");

    const settings: CodeExtractionSettings = {
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

    // Map credentials to settings
    codeExtractionCredentials.forEach((cred) => {
      if (cred.key in settings) {
        const key = cred.key as keyof CodeExtractionSettings;
        if (typeof settings[key] === "number") {
          if (key === "MAX_PROSE_RATIO") {
            settings[key] = parseFloat(cred.value || "0.15");
          } else {
            settings[key] = parseInt(
              cred.value || settings[key].toString(),
              10,
            );
          }
        } else if (typeof settings[key] === "boolean") {
          settings[key] = cred.value === "true";
        }
      }
    });

    return settings;
  }

  async updateCodeExtractionSettings(
    settings: CodeExtractionSettings,
  ): Promise<void> {
    const promises = [];

    // Update all code extraction settings
    for (const [key, value] of Object.entries(settings)) {
      promises.push(
        this.updateCredential({
          key,
          value: value.toString(),
          is_encrypted: false,
          category: "code_extraction",
        }),
      );
    }

    await Promise.all(promises);
  }
}

export const credentialsService = new CredentialsService();
