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
  LLM_INSTANCE_NAME?: string;
  OLLAMA_EMBEDDING_URL?: string;
  OLLAMA_EMBEDDING_INSTANCE_NAME?: string;
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

export interface OllamaInstance {
  id: string;
  name: string;
  baseUrl: string;
  isEnabled: boolean;
  isPrimary: boolean;
  instanceType?: 'chat' | 'embedding' | 'both';
  loadBalancingWeight?: number;
  isHealthy?: boolean;
  responseTimeMs?: number;
  modelsAvailable?: number;
  lastHealthCheck?: string;
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
      LLM_INSTANCE_NAME: "",
      OLLAMA_EMBEDDING_URL: "",
      OLLAMA_EMBEDDING_INSTANCE_NAME: "",
      EMBEDDING_MODEL: "",
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
            "LLM_INSTANCE_NAME",
            "OLLAMA_EMBEDDING_URL",
            "OLLAMA_EMBEDDING_INSTANCE_NAME",
            "EMBEDDING_MODEL",
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

  // Ollama Instance Management
  async getOllamaInstances(): Promise<OllamaInstance[]> {
    try {
      const ollamaCredentials = await this.getCredentialsByCategory('ollama_instances');
      
      // Convert credentials to OllamaInstance objects
      const instances: OllamaInstance[] = [];
      const instanceMap: Record<string, Partial<OllamaInstance>> = {};
      
      // Group credentials by instance ID
      ollamaCredentials.forEach(cred => {
        const parts = cred.key.split('_');
        if (parts.length >= 3 && parts[0] === 'ollama' && parts[1] === 'instance') {
          const instanceId = parts[2];
          const field = parts.slice(3).join('_');
          
          if (!instanceMap[instanceId]) {
            instanceMap[instanceId] = { id: instanceId };
          }
          
          // Parse the field value
          let value: any = cred.value;
          if (field === 'isEnabled' || field === 'isPrimary' || field === 'isHealthy') {
            value = cred.value === 'true';
          } else if (field === 'responseTimeMs' || field === 'modelsAvailable' || field === 'loadBalancingWeight') {
            value = parseInt(cred.value || '0', 10);
          }
          
          (instanceMap[instanceId] as any)[field] = value;
        }
      });
      
      // Convert to array and ensure required fields
      Object.values(instanceMap).forEach(instance => {
        if (instance.id && instance.name && instance.baseUrl) {
          instances.push({
            id: instance.id,
            name: instance.name,
            baseUrl: instance.baseUrl,
            isEnabled: instance.isEnabled ?? true,
            isPrimary: instance.isPrimary ?? false,
            instanceType: instance.instanceType ?? 'both',
            loadBalancingWeight: instance.loadBalancingWeight ?? 100,
            isHealthy: instance.isHealthy,
            responseTimeMs: instance.responseTimeMs,
            modelsAvailable: instance.modelsAvailable,
            lastHealthCheck: instance.lastHealthCheck
          });
        }
      });
      
      return instances;
    } catch (error) {
      console.error('Failed to load Ollama instances from database:', error);
      return [];
    }
  }

  async setOllamaInstances(instances: OllamaInstance[]): Promise<void> {
    try {
      // First, delete existing ollama instance credentials
      const existingCredentials = await this.getCredentialsByCategory('ollama_instances');
      for (const cred of existingCredentials) {
        await this.deleteCredential(cred.key);
      }
      
      // Add new instance credentials
      const promises: Promise<any>[] = [];
      
      instances.forEach(instance => {
        const fields: Record<string, any> = {
          name: instance.name,
          baseUrl: instance.baseUrl,
          isEnabled: instance.isEnabled,
          isPrimary: instance.isPrimary,
          instanceType: instance.instanceType || 'both',
          loadBalancingWeight: instance.loadBalancingWeight || 100
        };
        
        // Add optional health-related fields
        if (instance.isHealthy !== undefined) {
          fields.isHealthy = instance.isHealthy;
        }
        if (instance.responseTimeMs !== undefined) {
          fields.responseTimeMs = instance.responseTimeMs;
        }
        if (instance.modelsAvailable !== undefined) {
          fields.modelsAvailable = instance.modelsAvailable;
        }
        if (instance.lastHealthCheck) {
          fields.lastHealthCheck = instance.lastHealthCheck;
        }
        
        // Create a credential for each field
        Object.entries(fields).forEach(([field, value]) => {
          promises.push(
            this.createCredential({
              key: `ollama_instance_${instance.id}_${field}`,
              value: value.toString(),
              is_encrypted: false,
              category: 'ollama_instances'
            })
          );
        });
      });
      
      await Promise.all(promises);
    } catch (error) {
      throw this.handleCredentialError(error, 'Saving Ollama instances');
    }
  }

  async addOllamaInstance(instance: OllamaInstance): Promise<void> {
    const instances = await this.getOllamaInstances();
    instances.push(instance);
    await this.setOllamaInstances(instances);
  }

  async updateOllamaInstance(instanceId: string, updates: Partial<OllamaInstance>): Promise<void> {
    const instances = await this.getOllamaInstances();
    const instanceIndex = instances.findIndex(inst => inst.id === instanceId);
    
    if (instanceIndex === -1) {
      throw new Error(`Ollama instance with ID ${instanceId} not found`);
    }
    
    instances[instanceIndex] = { ...instances[instanceIndex], ...updates };
    await this.setOllamaInstances(instances);
  }

  async removeOllamaInstance(instanceId: string): Promise<void> {
    const instances = await this.getOllamaInstances();
    const filteredInstances = instances.filter(inst => inst.id !== instanceId);
    
    if (filteredInstances.length === instances.length) {
      throw new Error(`Ollama instance with ID ${instanceId} not found`);
    }
    
    await this.setOllamaInstances(filteredInstances);
  }

  async migrateOllamaFromLocalStorage(): Promise<{ migrated: boolean; instanceCount: number }> {
    try {
      // Check if there are existing instances in the database
      const existingInstances = await this.getOllamaInstances();
      if (existingInstances.length > 0) {
        return { migrated: false, instanceCount: 0 };
      }
      
      // Try to load from localStorage
      const localStorageData = localStorage.getItem('ollama-instances');
      if (!localStorageData) {
        return { migrated: false, instanceCount: 0 };
      }
      
      const localInstances = JSON.parse(localStorageData);
      if (!Array.isArray(localInstances) || localInstances.length === 0) {
        return { migrated: false, instanceCount: 0 };
      }
      
      // Migrate to database
      await this.setOllamaInstances(localInstances);
      
      // Clean up localStorage
      localStorage.removeItem('ollama-instances');
      
      return { migrated: true, instanceCount: localInstances.length };
    } catch (error) {
      console.error('Failed to migrate Ollama instances from localStorage:', error);
      return { migrated: false, instanceCount: 0 };
    }
  }
}

export const credentialsService = new CredentialsService();
