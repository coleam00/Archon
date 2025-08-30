/**
 * Ollama Service Client
 * 
 * Provides frontend API client for Ollama model discovery, validation, and health monitoring.
 * Integrates with the enhanced backend Ollama endpoints for multi-instance configurations.
 */

import { getApiUrl } from "../config/api";

// Type definitions for Ollama API responses
export interface OllamaModel {
  name: string;
  tag: string;
  size: number;
  digest: string;
  capabilities: ('chat' | 'embedding')[];
  embedding_dimensions?: number;
  parameters?: {
    family?: string;
    parameter_size?: string;
    quantization?: string;
    parameter_count?: string;
    format?: string;
  };
  instance_url: string;
  last_updated?: string;
  // Real API data from /api/show endpoint
  context_window?: number;
  architecture?: string;
  block_count?: number;
  attention_heads?: number;
  format?: string;
  parent_model?: string;
}

export interface ModelDiscoveryResponse {
  total_models: number;
  chat_models: Array<{
    name: string;
    instance_url: string;
    size: number;
    parameters?: any;
    // Real API data from /api/show
    context_window?: number;
    architecture?: string;
    block_count?: number;
    attention_heads?: number;
    format?: string;
    parent_model?: string;
    capabilities?: string[];
  }>;
  embedding_models: Array<{
    name: string;
    instance_url: string;
    dimensions?: number;
    size: number;
    parameters?: any;
    // Real API data from /api/show
    architecture?: string;
    format?: string;
    parent_model?: string;
    capabilities?: string[];
  }>;
  host_status: Record<string, {
    status: 'online' | 'error';
    error?: string;
    models_count?: number;
    instance_url?: string;
  }>;
  discovery_errors: string[];
  unique_model_names: string[];
}

export interface InstanceHealthResponse {
  summary: {
    total_instances: number;
    healthy_instances: number;
    unhealthy_instances: number;
    average_response_time_ms?: number;
  };
  instance_status: Record<string, {
    is_healthy: boolean;
    response_time_ms?: number;
    models_available?: number;
    error_message?: string;
    last_checked?: string;
  }>;
  timestamp: string;
}

export interface InstanceValidationResponse {
  is_valid: boolean;
  instance_url: string;
  response_time_ms?: number;
  models_available: number;
  error_message?: string;
  capabilities: {
    total_models?: number;
    chat_models?: string[];
    embedding_models?: string[];
    supported_dimensions?: number[];
    error?: string;
  };
  health_status: Record<string, any>;
}

export interface EmbeddingRouteResponse {
  target_column: string;
  model_name: string;
  instance_url: string;
  dimensions: number;
  confidence: number;
  fallback_applied: boolean;
  routing_strategy: string;
  performance_score?: number;
}

export interface EmbeddingRoutesResponse {
  total_routes: number;
  routes: Array<{
    model_name: string;
    instance_url: string;
    dimensions: number;
    column_name: string;
    performance_score: number;
    index_type: string;
  }>;
  dimension_analysis: Record<string, {
    count: number;
    models: string[];
    avg_performance: number;
  }>;
  routing_statistics: Record<string, any>;
}

// Request interfaces
export interface ModelDiscoveryOptions {
  instanceUrls: string[];
  includeCapabilities?: boolean;
}

export interface InstanceValidationOptions {
  instanceUrl: string;
  instanceType?: 'chat' | 'embedding' | 'both';
  timeoutSeconds?: number;
}

export interface EmbeddingRouteOptions {
  modelName: string;
  instanceUrl: string;
  textSample?: string;
}

class OllamaService {
  private baseUrl = getApiUrl();

  private handleApiError(error: any, context: string): Error {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for network errors
    if (
      errorMessage.toLowerCase().includes("network") ||
      errorMessage.includes("fetch") ||
      errorMessage.includes("Failed to fetch")
    ) {
      return new Error(
        `Network error while ${context.toLowerCase()}: ${errorMessage}. ` +
          `Please check your connection and Ollama server status.`,
      );
    }

    // Check for timeout errors
    if (errorMessage.includes("timeout") || errorMessage.includes("AbortError")) {
      return new Error(
        `Timeout error while ${context.toLowerCase()}: The Ollama instance may be slow to respond or unavailable.`
      );
    }

    // Return original error with context
    return new Error(`${context} failed: ${errorMessage}`);
  }

  /**
   * Discover models from multiple Ollama instances
   */
  async discoverModels(options: ModelDiscoveryOptions): Promise<ModelDiscoveryResponse> {
    try {
      if (!options.instanceUrls || options.instanceUrls.length === 0) {
        throw new Error("At least one instance URL is required for model discovery");
      }

      // Build query parameters
      const params = new URLSearchParams();
      options.instanceUrls.forEach(url => {
        params.append('instance_urls', url);
      });
      
      if (options.includeCapabilities !== undefined) {
        params.append('include_capabilities', options.includeCapabilities.toString());
      }

      const response = await fetch(`${this.baseUrl}/api/ollama/models?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      throw this.handleApiError(error, "Model discovery");
    }
  }

  /**
   * Check health status of multiple Ollama instances
   */
  async checkInstanceHealth(instanceUrls: string[], includeModels: boolean = false): Promise<InstanceHealthResponse> {
    try {
      if (!instanceUrls || instanceUrls.length === 0) {
        throw new Error("At least one instance URL is required for health checking");
      }

      // Build query parameters
      const params = new URLSearchParams();
      instanceUrls.forEach(url => {
        params.append('instance_urls', url);
      });
      
      if (includeModels) {
        params.append('include_models', 'true');
      }

      const response = await fetch(`${this.baseUrl}/api/ollama/instances/health?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      throw this.handleApiError(error, "Instance health checking");
    }
  }

  /**
   * Validate a specific Ollama instance with comprehensive testing
   */
  async validateInstance(options: InstanceValidationOptions): Promise<InstanceValidationResponse> {
    try {
      const requestBody = {
        instance_url: options.instanceUrl,
        instance_type: options.instanceType,
        timeout_seconds: options.timeoutSeconds || 30,
      };

      const response = await fetch(`${this.baseUrl}/api/ollama/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      throw this.handleApiError(error, "Instance validation");
    }
  }

  /**
   * Analyze embedding routing for a specific model and instance
   */
  async analyzeEmbeddingRoute(options: EmbeddingRouteOptions): Promise<EmbeddingRouteResponse> {
    try {
      const requestBody = {
        model_name: options.modelName,
        instance_url: options.instanceUrl,
        text_sample: options.textSample,
      };

      const response = await fetch(`${this.baseUrl}/api/ollama/embedding/route`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      throw this.handleApiError(error, "Embedding route analysis");
    }
  }

  /**
   * Get all available embedding routes across multiple instances
   */
  async getEmbeddingRoutes(instanceUrls: string[], sortByPerformance: boolean = true): Promise<EmbeddingRoutesResponse> {
    try {
      if (!instanceUrls || instanceUrls.length === 0) {
        throw new Error("At least one instance URL is required for embedding routes");
      }

      // Build query parameters
      const params = new URLSearchParams();
      instanceUrls.forEach(url => {
        params.append('instance_urls', url);
      });
      
      if (sortByPerformance) {
        params.append('sort_by_performance', 'true');
      }

      const response = await fetch(`${this.baseUrl}/api/ollama/embedding/routes?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      throw this.handleApiError(error, "Getting embedding routes");
    }
  }

  /**
   * Clear all Ollama-related caches
   */
  async clearCaches(): Promise<{ message: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/ollama/cache`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      throw this.handleApiError(error, "Cache clearing");
    }
  }

  /**
   * Test connectivity to a single Ollama instance (quick health check)
   */
  async testConnection(instanceUrl: string): Promise<{ isHealthy: boolean; responseTime?: number; error?: string }> {
    try {
      const startTime = Date.now();
      
      const healthResponse = await this.checkInstanceHealth([instanceUrl], false);
      const responseTime = Date.now() - startTime;
      
      const instanceStatus = healthResponse.instance_status[instanceUrl];
      
      return {
        isHealthy: instanceStatus?.is_healthy || false,
        responseTime: instanceStatus?.response_time_ms || responseTime,
        error: instanceStatus?.error_message,
      };
    } catch (error) {
      return {
        isHealthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get model capabilities for a specific model
   */
  async getModelCapabilities(modelName: string, instanceUrl: string): Promise<{
    supports_chat: boolean;
    supports_embedding: boolean;
    embedding_dimensions?: number;
    error?: string;
  }> {
    try {
      // Use the validation endpoint to get capabilities
      const validation = await this.validateInstance({
        instanceUrl,
        instanceType: 'both',
      });

      const capabilities = validation.capabilities;
      const chatModels = capabilities.chat_models || [];
      const embeddingModels = capabilities.embedding_models || [];

      // Find the model in the lists
      const supportsChat = chatModels.includes(modelName);
      const supportsEmbedding = embeddingModels.includes(modelName);

      // For embedding dimensions, we need to use the embedding route analysis
      let embeddingDimensions: number | undefined;
      if (supportsEmbedding) {
        try {
          const route = await this.analyzeEmbeddingRoute({
            modelName,
            instanceUrl,
          });
          embeddingDimensions = route.dimensions;
        } catch (error) {
          // Ignore routing errors, just report basic capability
        }
      }

      return {
        supports_chat: supportsChat,
        supports_embedding: supportsEmbedding,
        embedding_dimensions: embeddingDimensions,
      };
    } catch (error) {
      return {
        supports_chat: false,
        supports_embedding: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// Export singleton instance
export const ollamaService = new OllamaService();