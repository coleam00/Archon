export interface OllamaInstance {
  id: string;
  name: string;
  baseUrl: string;
  isEnabled: boolean;
  isPrimary: boolean;
  instanceType?: 'chat' | 'embedding' | 'both';
  isHealthy?: boolean;
  responseTimeMs?: number;
  modelsAvailable?: number;
  lastHealthCheck?: string;
  loadBalancingWeight?: number;
}

export interface OllamaModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at: string;
  format?: string;
  family?: string;
  parameter_size?: string;
  quantization_level?: string;
}

export interface ModelSelectionState {
  selectedInstanceId: string | null;
  chatModel: string | null;
  embeddingModel: string | null;
}

export interface ConnectionTestResult {
  isHealthy: boolean;
  responseTimeMs?: number;
  modelsAvailable?: number;
  error?: string;
}
