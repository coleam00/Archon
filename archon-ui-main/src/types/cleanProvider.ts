/**
 * Clean Provider System Types
 * 
 * TypeScript types for the simplified provider system
 */

// Provider types - now supports dynamic providers from OpenRouter
export type ProviderType = string;  // Allow any string for dynamic providers

export type ServiceType = 
  | 'document_agent'
  | 'rag_agent'
  | 'task_agent'
  | 'embeddings'
  | 'contextual_embedding'
  | 'source_summary'
  | 'code_summary'
  | 'code_analysis' 
  | 'validation';

export type ModelFamily = 
  | 'gpt-4'
  | 'gpt-3.5'
  | 'claude-3'
  | 'gemini'
  | 'llama'
  | 'mixtral'
  | 'mistral';

export type ProviderHealth = 
  | 'healthy' 
  | 'degraded' 
  | 'error' 
  | 'not_configured';

// Model configuration
export interface ModelConfig {
  service_name: ServiceType;
  model_string: string;
  temperature?: number;
  max_tokens?: number;
  created_at?: string;
  updated_at?: string;
}

// API key configuration
export interface APIKeyConfig {
  provider: ProviderType;
  encrypted_key: string;
  is_active: boolean;
  base_url?: string;
  created_at?: string;
  updated_at?: string;
}

// Available model info
export interface AvailableModel {
  provider: string;  // Changed from ProviderType to string to be more flexible
  model: string;
  model_string: string;
  display_name: string;
  has_api_key: boolean;
  cost_tier?: 'low' | 'medium' | 'high' | 'free' | null;
  estimated_cost_per_1k?: {
    input: number;
    output: number;
  } | null;
  is_embedding?: boolean;  // Flag to identify embedding models
  model_id?: string;
  description?: string;
  context_length?: number;
  input_cost?: number;
  output_cost?: number;
  supports_vision?: boolean;
  supports_tools?: boolean;
  supports_reasoning?: boolean;
}

// Service status
export interface ServiceStatus {
  service_name: ServiceType;
  model_string: string;
  provider: ProviderType;
  is_configured: boolean;
  health: ProviderHealth;
  last_used?: string;
}

// Usage tracking
export interface UsageSummary {
  total_cost: number;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  providers: Array<{
    provider_id: string;
    provider_name: string;
    cost: number;
    requests: number;
  }>;
  models: Array<{
    model_id: string;
    model_name: string;
    cost: number;
    requests: number;
  }>;
  period_start?: string;
  period_end?: string;
}

// Provider metadata from backend
export interface ProviderMetadata {
  provider: string;
  model_count: number;
  max_context_length: number;
  min_input_cost: number;
  max_input_cost: number;
  has_free_models: boolean;
  supports_vision: boolean;
  supports_tools: boolean;
  top_models?: Array<{
    model: string;
    context_length: number;
    input_cost: number;
    output_cost: number;
  }>;
}

export interface DailyCosts {
  dates: string[];
  costs: number[];
  total: number;
}

export interface MonthlyEstimate {
  estimated_cost: number;
  days_elapsed: number;
  days_remaining: number;
  current_rate: number;
}

// Request/Response types
export interface UpdateModelConfigRequest {
  service_name: ServiceType;
  model_string: string;
  temperature?: number;
  max_tokens?: number;
}

export interface SetApiKeyRequest {
  provider: ProviderType;
  api_key: string;
  base_url?: string;
}

export interface InitializeResponse {
  status: string;
  initialized_providers: string[];
  message: string;
}

// Provider status for UI
export interface ProviderStatus {
  provider: ProviderType;
  health: ProviderHealth;
  configured: boolean;
  lastChecked: string;
}

// Model family info for UI
export interface ModelFamilyInfo {
  provider: ProviderType;
  displayName: string;
  requiresApiKey: boolean;
  configurable?: {
    baseUrl?: boolean;
  };
  models: Array<{
    id: string;
    name: string;
    costTier: 'low' | 'medium' | 'high' | 'free';
  }>;
}