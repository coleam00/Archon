/**
 * Agent Service API Layer
 * Clean interface for agent-related operations using TanStack Query
 */

import type { ModelConfig } from "../types";
import type { ProviderType, ServiceType } from "../../../types/cleanProvider";
import { cleanProviderService } from "../../../services/cleanProviderService";

// Specific API functions that will be used by TanStack Query
export const agentApi = {
  // Models
  getAvailableModels: () => cleanProviderService.getAvailableModels(),

  // Agent configs
  getAllAgentConfigs: () => cleanProviderService.getAllAgentConfigs(),
  getAgentConfig: (serviceId: ServiceType) =>
    cleanProviderService.getModelConfig(serviceId),
  updateAgentConfig: (serviceId: ServiceType, config: ModelConfig) =>
    cleanProviderService.updateAgentConfig(serviceId, config.model_string, {
      temperature: config.temperature,
      max_tokens: config.max_tokens,
    }),

  // Providers
  getActiveProviders: () => cleanProviderService.getActiveProviders(),
  getProvidersMetadata: () => cleanProviderService.getProvidersMetadata(),
  getAllProviders: () => cleanProviderService.getAllProviders(),

  // API Keys
  setApiKey: (provider: ProviderType, apiKey: string, baseUrl?: string) =>
    cleanProviderService.setApiKey(provider, apiKey, baseUrl),
  removeApiKey: (provider: ProviderType) =>
    cleanProviderService.deleteApiKey(provider),
  testApiKey: (provider: ProviderType) =>
    cleanProviderService.testApiKey(provider),
};
