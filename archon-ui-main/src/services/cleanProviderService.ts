/**
 * Clean Provider Service
 * 
 * Service for managing AI provider configuration, API keys, and usage tracking
 * using the simplified provider system.
 */

import { apiRequest } from './api';
import type {
  ModelConfig,
  APIKeyConfig,
  AvailableModel,
  ServiceStatus,
  UsageSummary,
  DailyCosts,
  MonthlyEstimate,
  UpdateModelConfigRequest,
  SetApiKeyRequest,
  InitializeResponse,
  ProviderType,
  ServiceType,
  ProviderStatus,
  ProviderHealth
} from '../types/cleanProvider';

// API base path (no /api prefix since apiRequest adds it)
const API_BASE = '/providers';

class CleanProviderService {
  // ==================== Model Configuration ====================
  
  /**
   * Get model configuration for a specific service
   */
  async getModelConfig(serviceName: ServiceType): Promise<ModelConfig> {
    return apiRequest<ModelConfig>(`${API_BASE}/models/config/${serviceName}`);
  }

  /**
   * Update model configuration for a service
   */
  async updateModelConfig(
    serviceName: ServiceType,
    modelString: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
    }
  ): Promise<ModelConfig> {
    const request: UpdateModelConfigRequest = {
      service_name: serviceName,
      model_string: modelString,
      ...options
    };

    return apiRequest<ModelConfig>(`${API_BASE}/models/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
  }

  /**
   * Get all service model configurations
   */
  async getAllConfigs(): Promise<Record<string, string>> {
    return apiRequest<Record<string, string>>(`${API_BASE}/models/configs`);
  }

  /**
   * Get status of all configured services
   */
  async getServiceStatus(): Promise<ServiceStatus[]> {
    return apiRequest<ServiceStatus[]>(`${API_BASE}/models/status`);
  }

  /**
   * Get available models based on configured API keys
   */
  async getAvailableModels(): Promise<AvailableModel[]> {
    try {
      const response = await apiRequest<AvailableModel[]>(`${API_BASE}/models/available`);
      console.log('[CleanProviderService] getAvailableModels response:', response);
      return response;
    } catch (error) {
      console.error('[CleanProviderService] Failed to get available models:', error);
      throw error;
    }
  }

  // ==================== API Key Management ====================

  /**
   * Set an API key for a provider
   */
  async setApiKey(
    provider: ProviderType,
    apiKey: string,
    baseUrl?: string
  ): Promise<{ status: string; provider: string }> {
    const request: SetApiKeyRequest = {
      provider,
      api_key: apiKey,
      base_url: baseUrl
    };

    return apiRequest(`${API_BASE}/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
  }

  /**
   * Get list of providers with active API keys
   */
  async getActiveProviders(): Promise<string[]> {
    return apiRequest<string[]>(`${API_BASE}/api-keys/providers`);
  }

  /**
   * Deactivate an API key for a provider
   */
  async deactivateApiKey(provider: ProviderType): Promise<{ status: string; provider: string }> {
    return apiRequest(`${API_BASE}/api-keys/${provider}`, {
      method: 'DELETE'
    });
  }

  /**
   * Test if a provider's API key is configured
   */
  async testApiKey(provider: ProviderType): Promise<{
    provider: string;
    configured: boolean;
    status: string;
  }> {
    return apiRequest(`${API_BASE}/api-keys/test/${provider}`, {
      method: 'POST'
    });
  }

  // ==================== Usage Tracking ====================

  /**
   * Get usage summary across all services
   */
  async getUsageSummary(
    startDate?: Date,
    endDate?: Date
  ): Promise<UsageSummary> {
    const params = new URLSearchParams();
    if (startDate) params.append('start_date', startDate.toISOString());
    if (endDate) params.append('end_date', endDate.toISOString());

    const url = params.toString() 
      ? `${API_BASE}/usage/summary?${params}`
      : `${API_BASE}/usage/summary`;

    return apiRequest<UsageSummary>(url);
  }

  /**
   * Get daily costs for the last N days
   */
  async getDailyCosts(days: number = 7): Promise<DailyCosts> {
    return apiRequest<DailyCosts>(`${API_BASE}/usage/daily?days=${days}`);
  }

  /**
   * Estimate monthly cost based on current usage
   */
  async estimateMonthlyCost(): Promise<MonthlyEstimate> {
    return apiRequest<MonthlyEstimate>(`${API_BASE}/usage/estimate-monthly`);
  }

  // ==================== System ====================

  /**
   * Initialize the provider system (set up environment variables)
   */
  async initialize(): Promise<InitializeResponse> {
    return apiRequest<InitializeResponse>(`${API_BASE}/initialize`, {
      method: 'POST'
    });
  }

  // ==================== Agent Configuration ====================

  /**
   * Get configuration for a specific agent
   */
  async getAgentConfig(agentId: string): Promise<ModelConfig> {
    return this.getModelConfig(agentId as ServiceType);
  }

  /**
   * Update configuration for a specific agent
   */
  async updateAgentConfig(
    agentId: string,
    modelString: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
    }
  ): Promise<ModelConfig> {
    return this.updateModelConfig(agentId as ServiceType, modelString, options);
  }

  /**
   * Get configurations for all agents
   */
  async getAllAgentConfigs(): Promise<Record<string, ModelConfig>> {
    const configs = await this.getAllConfigs();
    const agentConfigs: Record<string, ModelConfig> = {};
    
    // Filter to only agent/service configs we care about
    const agentIds = [
      'document_agent', 'rag_agent', 'task_agent',
      'embeddings', 'contextual_embedding',
      'source_summary', 'code_summary',
      'code_analysis', 'validation'
    ];
    
    for (const id of agentIds) {
      if (configs[id]) {
        agentConfigs[id] = {
          service_name: id as ServiceType,
          model_string: configs[id],
          temperature: 0.7, // Will be fetched from DB in real implementation
          max_tokens: 2000
        };
      }
    }
    
    return agentConfigs;
  }

  /**
   * Get active models status for all services
   * This shows exactly what models are being used by each service
   */
  async getActiveModels(): Promise<{
    active_models: Record<string, {
      model_string: string;
      provider: string;
      model: string;
      api_key_configured: boolean;
      is_default?: boolean;
    }>;
    api_key_status: Record<string, boolean>;
    usage?: {
      total_tokens_today: number;
      total_cost_today: number;
      estimated_monthly_cost: number;
    };
    timestamp: string;
  }> {
    const response = await apiRequest(`${API_BASE}/active-models`);
    return response;
  }

  /**
   * Get usage statistics grouped by agent
   */
  async getAgentUsageStats(
    startDate?: Date,
    endDate?: Date
  ): Promise<Array<{
    agent_id: string;
    total_requests: number;
    total_cost: number;
    avg_response_time_ms: number;
  }>> {
    const summary = await this.getUsageSummary(startDate, endDate);
    
    // Transform usage data to be agent-centric
    // This would be properly implemented with backend support
    return [];
  }

  // ==================== Helper Methods ====================

  /**
   * Get provider health status
   */
  async getProviderHealth(provider: ProviderType): Promise<ProviderHealth> {
    try {
      const result = await this.testApiKey(provider);
      if (result.configured && result.status === 'active') {
        return 'healthy';
      } else if (result.configured) {
        return 'degraded';
      } else {
        return 'not_configured';
      }
    } catch {
      return 'error';
    }
  }

  /**
   * Get list of all available providers
   */
  async getAllProviders(): Promise<string[]> {
    try {
      return await apiRequest<string[]>(`${API_BASE}/providers/list`);
    } catch {
      // Fallback to common providers if API fails
      return [
        'openai', 'anthropic', 'google', 'mistral',
        'meta', 'deepseek', 'groq', 'cohere',
        'ai21', 'xai', 'ollama', 'openrouter'
      ];
    }
  }

  /**
   * Get all provider statuses
   */
  async getAllProviderStatuses(): Promise<ProviderStatus[]> {
    const [allProviders, activeProviders] = await Promise.all([
      this.getAllProviders(),
      this.getActiveProviders()
    ]);

    const statuses: ProviderStatus[] = [];
    
    // Show all providers (the search/filter will help manage large lists)
    for (const provider of allProviders) {
      const isActive = activeProviders.includes(provider);
      const health = isActive ? await this.getProviderHealth(provider) : 'not_configured';
      
      statuses.push({
        provider: provider as ProviderType,
        health,
        configured: isActive,
        lastChecked: new Date().toISOString()
      });
    }

    return statuses;
  }

  /**
   * Get metadata for all providers
   */
  async getProvidersMetadata(): Promise<Record<string, any>> {
    try {
      return await apiRequest<Record<string, any>>(`${API_BASE}/providers/metadata`);
    } catch {
      return {};
    }
  }

  /**
   * Get metadata for a specific provider
   */
  async getProviderMetadata(provider: string): Promise<any> {
    try {
      return await apiRequest<any>(`${API_BASE}/providers/${provider}/metadata`);
    } catch {
      return null;
    }
  }

}

// Export singleton instance
export const cleanProviderService = new CleanProviderService();

// Export types for convenience
export type { 
  ModelConfig,
  ServiceStatus,
  AvailableModel,
  UsageSummary,
  ProviderType,
  ServiceType
};