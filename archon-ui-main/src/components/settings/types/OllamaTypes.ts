/**
 * TypeScript type definitions for Ollama components and services
 * 
 * Provides comprehensive type definitions for Ollama multi-instance management,
 * model discovery, and health monitoring across the frontend application.
 */

// Core Ollama instance configuration
export interface OllamaInstance {
  id: string;
  name: string;
  baseUrl: string;
  instanceType: 'chat' | 'embedding' | 'both';
  isEnabled: boolean;
  isPrimary: boolean;
  healthStatus: {
    isHealthy: boolean;
    lastChecked: Date;
    responseTimeMs?: number;
    error?: string;
  };
  loadBalancingWeight?: number;
  lastHealthCheck?: string;
  modelsAvailable?: number;
  responseTimeMs?: number;
}

// Configuration for dual-host setups
export interface OllamaConfiguration {
  chatInstance: OllamaInstance;
  embeddingInstance: OllamaInstance;
  selectedChatModel?: string;
  selectedEmbeddingModel?: string;
  fallbackToChatInstance: boolean;
}

// Model information from discovery
export interface OllamaModel {
  name: string;
  tag: string;
  size: number;
  digest: string;
  capabilities: ('chat' | 'embedding')[];
  embeddingDimensions?: number;
  parameters?: {
    family: string;
    parameterSize: string;
    quantization: string;
  };
  instanceUrl: string;
}

// Health status for instances
export interface InstanceHealth {
  instanceUrl: string;
  isHealthy: boolean;
  responseTimeMs?: number;
  modelsAvailable?: number;
  errorMessage?: string;
  lastChecked?: string;
}

// Model discovery results
export interface ModelDiscoveryResults {
  totalModels: number;
  chatModels: OllamaModel[];
  embeddingModels: OllamaModel[];
  hostStatus: Record<string, {
    status: 'online' | 'error';
    modelsCount?: number;
    error?: string;
  }>;
  discoveryErrors: string[];
}

// Props for modal components
export interface ModelDiscoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectModels: (models: { chatModel?: string; embeddingModel?: string }) => void;
  instances: OllamaInstance[];
}

// Props for health indicator component
export interface HealthIndicatorProps {
  instance: OllamaInstance;
  onRefresh: (instanceId: string) => void;
  showDetails?: boolean;
}

// Props for configuration panel
export interface ConfigurationPanelProps {
  isVisible: boolean;
  onConfigChange: (instances: OllamaInstance[]) => void;
  className?: string;
  separateHosts?: boolean;
}

// Validation and error types
export interface ValidationResult {
  isValid: boolean;
  message: string;
  details?: string;
  suggestedAction?: string;
}

export interface ConnectionTestResult {
  isHealthy: boolean;
  responseTimeMs?: number;
  modelsAvailable?: number;
  error?: string;
}

// UI State types
export interface ModelSelectionState {
  selectedChatModel: string | null;
  selectedEmbeddingModel: string | null;
  filterText: string;
  showOnlyEmbedding: boolean;
  showOnlyChat: boolean;
  sortBy: 'name' | 'size' | 'instance';
}

// Form data types
export interface AddInstanceFormData {
  name: string;
  baseUrl: string;
  instanceType: 'chat' | 'embedding' | 'both';
}

// Embedding routing information
export interface EmbeddingRoute {
  modelName: string;
  instanceUrl: string;
  dimensions: number;
  targetColumn: string;
  performanceScore: number;
  confidence: number;
}

// Statistics and monitoring
export interface InstanceStatistics {
  totalInstances: number;
  activeInstances: number;
  averageResponseTime?: number;
  totalModels: number;
  healthyInstancesCount: number;
}

// Event types for component communication
export type OllamaEvent = 
  | { type: 'INSTANCE_ADDED'; payload: OllamaInstance }
  | { type: 'INSTANCE_REMOVED'; payload: string }
  | { type: 'INSTANCE_UPDATED'; payload: OllamaInstance }
  | { type: 'HEALTH_CHECK_COMPLETED'; payload: { instanceId: string; result: ConnectionTestResult } }
  | { type: 'MODEL_DISCOVERY_COMPLETED'; payload: ModelDiscoveryResults }
  | { type: 'CONFIGURATION_CHANGED'; payload: OllamaConfiguration };

// API Response types (re-export from service for convenience)
export type { 
  ModelDiscoveryResponse,
  InstanceHealthResponse,
  InstanceValidationResponse,
  EmbeddingRouteResponse,
  EmbeddingRoutesResponse 
} from '../../services/ollamaService';

// Error handling types
export interface OllamaError {
  code: string;
  message: string;
  context?: string;
  retryable?: boolean;
}

// Settings integration
export interface OllamaSettings {
  enableHealthMonitoring: boolean;
  healthCheckInterval: number;
  autoDiscoveryEnabled: boolean;
  modelCacheTtl: number;
  connectionTimeout: number;
  maxConcurrentHealthChecks: number;
}