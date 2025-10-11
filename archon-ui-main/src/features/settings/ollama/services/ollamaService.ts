import { credentialsService } from '../../../../services/credentialsService';
import type { OllamaInstance, ConnectionTestResult, OllamaModel } from '../types';
import { getApiUrl } from '../../../../config/api';

const baseUrl = getApiUrl();

export const ollamaService = {
  async listInstances(): Promise<OllamaInstance[]> {
    return credentialsService.getOllamaInstances();
  },

  async createInstance(instance: Omit<OllamaInstance, 'id'>): Promise<OllamaInstance> {
    const newInstance: OllamaInstance = {
      ...instance,
      id: `ollama-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };
    await credentialsService.addOllamaInstance(newInstance);
    return newInstance;
  },

  async updateInstance(id: string, updates: Partial<OllamaInstance>): Promise<OllamaInstance> {
    await credentialsService.updateOllamaInstance(id, updates);
    const instances = await credentialsService.getOllamaInstances();
    const updated = instances.find(inst => inst.id === id);
    if (!updated) {
      throw new Error(`Instance ${id} not found after update`);
    }
    return updated;
  },

  async deleteInstance(id: string): Promise<void> {
    await credentialsService.removeOllamaInstance(id);
  },

  async testConnection(instanceBaseUrl: string, retryCount = 3): Promise<ConnectionTestResult> {
    const maxRetries = retryCount;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const startTime = performance.now();
        const response = await fetch(`${baseUrl}/api/ollama/validate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            instance_url: instanceBaseUrl,
            instance_type: 'both',
            timeout_seconds: 30
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        const responseTimeMs = Math.round(performance.now() - startTime);

        return {
          isHealthy: data.is_valid === true,
          responseTimeMs,
          modelsAvailable: data.models_available || 0,
          error: data.is_valid ? undefined : data.error_message || 'Connection failed'
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    return {
      isHealthy: false,
      error: lastError?.message || 'Connection test failed after retries'
    };
  },

  async discoverModels(instance: OllamaInstance): Promise<OllamaModel[]> {
    try {
      const response = await fetch(`${instance.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: HTTP ${response.status}`);
      }

      const data = await response.json();
      return data.models || [];
    } catch (error) {
      console.error(`Failed to discover models for ${instance.name}:`, error);
      return [];
    }
  },

  async setModel(
    instanceId: string,
    modelType: 'chat' | 'embedding'
  ): Promise<void> {
    const instances = await this.listInstances();
    const instance = instances.find(inst => inst.id === instanceId);

    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (modelType === 'chat') {
      await credentialsService.updateCredential({
        key: 'LLM_BASE_URL',
        value: instance.baseUrl,
        is_encrypted: false,
        category: 'rag_strategy'
      });
      await credentialsService.updateCredential({
        key: 'LLM_INSTANCE_NAME',
        value: instance.name,
        is_encrypted: false,
        category: 'rag_strategy'
      });
      await credentialsService.updateCredential({
        key: 'LLM_PROVIDER',
        value: 'ollama',
        is_encrypted: false,
        category: 'rag_strategy'
      });
    } else {
      await credentialsService.updateCredential({
        key: 'OLLAMA_EMBEDDING_URL',
        value: instance.baseUrl,
        is_encrypted: false,
        category: 'rag_strategy'
      });
      await credentialsService.updateCredential({
        key: 'OLLAMA_EMBEDDING_INSTANCE_NAME',
        value: instance.name,
        is_encrypted: false,
        category: 'rag_strategy'
      });
      await credentialsService.updateCredential({
        key: 'EMBEDDING_PROVIDER',
        value: 'ollama',
        is_encrypted: false,
        category: 'rag_strategy'
      });
    }
  },
};
