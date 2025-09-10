/**
 * TanStack Query hooks for agent data
 */

import { useQuery } from "@tanstack/react-query";
import { useServiceRegistry } from "../../../contexts/ServiceRegistryContext";
import { agentApi } from "../services/agentService";
import { agentKeys, modelKeys, providerKeys, serviceKeys } from "../utils/queryKeys";

// Custom hook for smart polling intervals
const useSmartPolling = (defaultInterval: number) => {
  const refetchInterval = () =>
    typeof document !== "undefined" && document.visibilityState === "visible" ? defaultInterval : false;
  return { refetchInterval };
};

/**
 * Hook for available models with smart polling
 */
export const useAvailableModels = () => {
  const { refetchInterval } = useSmartPolling(10000); // 10s when tab active

  return useQuery({
    queryKey: modelKeys.available(),
    queryFn: agentApi.getAvailableModels,
    refetchInterval,
    staleTime: 5000, // Consider data stale after 5s
    retry: 3,
  });
};

/**
 * Hook for all agent configs with smart polling
 */
export const useAgentConfigs = () => {
  const { refetchInterval } = useSmartPolling(5000); // 5s when tab active

  return useQuery({
    queryKey: agentKeys.configs(),
    queryFn: agentApi.getAllAgentConfigs,
    refetchInterval,
    staleTime: 2000, // Consider data stale after 2s
    retry: 3,
  });
};

/**
 * Hook for provider metadata with smart polling
 */
export const useProvidersMetadata = () => {
  const { refetchInterval } = useSmartPolling(30000); // 30s - metadata changes less frequently

  return useQuery({
    queryKey: providerKeys.metadata(),
    queryFn: agentApi.getProvidersMetadata,
    refetchInterval,
    staleTime: 15000, // Consider data stale after 15s
    retry: 2,
  });
};

/**
 * Hook for provider list with smart polling
 */
export const useAllProviders = () => {
  const { refetchInterval } = useSmartPolling(60000); // 1min - provider list changes rarely

  return useQuery({
    queryKey: providerKeys.list(),
    queryFn: agentApi.getAllProviders,
    refetchInterval,
    staleTime: 30000, // Consider data stale after 30s
    retry: 2,
  });
};

/**
 * Hook for active providers (with API keys)
 */
export const useActiveProviders = () => {
  const { refetchInterval } = useSmartPolling(15000); // 15s - API key changes less frequently

  return useQuery({
    queryKey: providerKeys.apiKeys(),
    queryFn: agentApi.getActiveProviders,
    refetchInterval,
    staleTime: 5000, // Consider data stale after 5s
    retry: 3,
  });
};

/**
 * Hook that combines service registry with TanStack Query
 * Gradually migrate away from context
 */
export const useServices = () => {
  // Use the existing context for now, will migrate to TanStack Query later
  const serviceRegistry = useServiceRegistry();

  return {
    agents: serviceRegistry.agents,
    backendServices: serviceRegistry.backendServices,
    loading: serviceRegistry.loading,
    error: serviceRegistry.error,
    refreshServices: serviceRegistry.refreshServices,
  };
};
