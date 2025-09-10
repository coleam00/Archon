/**
 * Main hooks for agents feature
 */

import type { ModelConfig } from "../types";
import type { AgentConfig } from "../../../types/agent";
import {
  useAddProvider,
  useRemoveProvider,
  useTestProvider,
  useUpdateAgentConfig,
} from "./useAgentMutations";
import {
  useAgentConfigs,
  useAvailableModels,
  useServices,
} from "./useAgentQueries";

/**
 * Main hook for agents page data and operations
 * Replaces complex useState and useEffect patterns
 */
export const useAgents = () => {
  // Queries
  const availableModels = useAvailableModels();
  const agentConfigs = useAgentConfigs();
  const services = useServices();

  // Mutations
  const updateAgentConfig = useUpdateAgentConfig();
  const addProvider = useAddProvider();
  const removeProvider = useRemoveProvider();
  const testProvider = useTestProvider();

  // Transform services data to AgentConfig format for compatibility
  const transformedAgents: AgentConfig[] = (services.agents ?? []).map(
    (agent) => ({
      id: agent.service_name,
      name: agent.display_name,
      icon: agent.icon || "🤖",
      description: agent.description || "",
      category: "agent" as const,
      supportsTemperature: agent.supports_temperature,
      supportsMaxTokens: agent.supports_max_tokens,
      defaultModel: agent.default_model || "",
      modelType: (agent.model_type ?? "llm") as "llm" | "embedding",
      costProfile: (agent.cost_profile || "medium") as
        | "high"
        | "medium"
        | "low",
    })
  );

  const transformedBackendServices: AgentConfig[] = (
    services.backendServices ?? []
  ).map((service) => ({
    id: service.service_name,
    name: service.display_name,
    icon: service.icon || "⚙️",
    description: service.description || "",
    category: "service" as const,
    supportsTemperature: service.supports_temperature,
    supportsMaxTokens: service.supports_max_tokens,
    defaultModel: service.default_model || "",
    modelType: (service.model_type ?? "llm") as "llm" | "embedding",
    costProfile: (service.cost_profile || "medium") as
      | "high"
      | "medium"
      | "low",
  }));

  // Computed states
  const isLoading =
    availableModels.isLoading || agentConfigs.isLoading || services.loading;
  const hasModels =
    Array.isArray(availableModels.data) && availableModels.data.length > 0;

  // Operations
  const handleConfigUpdate = (agentId: string, config: ModelConfig) => {
    updateAgentConfig.mutate({ serviceId: agentId, config });
  };

  const handleProviderAdded = () => {
    // TanStack Query automatically handles refetching due to invalidateQueries
    // No manual reload needed
  };

  return {
    // Data
    availableModels: Array.isArray(availableModels.data)
      ? availableModels.data
      : [],
    agentConfigs: agentConfigs.data || {},
    agents: transformedAgents,
    backendServices: transformedBackendServices,

    // States
    isLoading,
    hasModels,
    servicesError: services.error,

    // Operations
    handleConfigUpdate,
    handleProviderAdded,
    addProvider: addProvider.mutate,
    removeProvider: removeProvider.mutate,
    testProvider: testProvider.mutate,

    // Mutation states
    isAddingProvider: addProvider.isPending,
    isRemovingProvider: removeProvider.isPending,
    isTestingProvider: testProvider.isPending,
    isUpdatingConfig: updateAgentConfig.isPending,
  };
};

// Re-export individual hooks for granular usage
export {
  useAvailableModels,
  useAgentConfigs,
  useServices,
  useUpdateAgentConfig,
  useAddProvider,
  useRemoveProvider,
  useTestProvider,
};

// Re-export optimistic update utilities
export * from "../utils/optimisticUpdates";
