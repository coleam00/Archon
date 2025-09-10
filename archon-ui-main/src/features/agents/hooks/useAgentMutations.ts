/**
 * TanStack Query mutations for agent operations
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../../contexts/ToastContext";
import { agentApi } from "../services/agentService";
import type {
  AgentConfigUpdate,
  ProviderOperation,
  ModelConfig,
} from "../types";
import { agentKeys, modelKeys, providerKeys } from "../utils/queryKeys";

/**
 * Hook for updating agent model configuration with optimistic updates
 */
export const useUpdateAgentConfig = () => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async ({ serviceId, config }: AgentConfigUpdate) => {
      return agentApi.updateAgentConfig(serviceId, config);
    },
    retry: (failureCount, error) => {
      // Retry up to 2 times for network errors, but not for validation errors
      if (failureCount >= 2) return false;
      if (error instanceof Error && error.message.includes("validation"))
        return false;
      return true;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff
    onMutate: async ({ serviceId, config }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: agentKeys.configs() });

      // Snapshot the previous value
      const previousConfigs = queryClient.getQueryData(agentKeys.configs());

      // Optimistically update the cache
      queryClient.setQueryData(
        agentKeys.configs(),
        (old: Record<string, ModelConfig> | undefined) => ({
          ...old,
          [serviceId]: config,
        })
      );

      return { previousConfigs };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousConfigs) {
        queryClient.setQueryData(agentKeys.configs(), context.previousConfigs);
      }

      // Enhanced error handling with more specific messages
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error occurred";
      showToast(
        `Failed to update ${variables.serviceId} configuration: ${errorMessage}`,
        "error"
      );
    },
    onSuccess: (_data, variables) => {
      showToast(
        `${variables.serviceId} configuration updated successfully`,
        "success"
      );

      // Dispatch event to notify ModelStatusBar of configuration changes
      const event = new CustomEvent("agentConfigUpdated", {
        detail: {
          serviceId: variables.serviceId,
          config: variables.config,
          timestamp: new Date().toISOString(),
        },
      });
      window.dispatchEvent(event);

      // Ensure cache consistency with server state
      queryClient.invalidateQueries({ queryKey: agentKeys.configs() });
    },
    onSettled: () => {
      // Always refetch to ensure consistency, but with a slight delay to show optimistic update
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: agentKeys.configs() });
      }, 1000);
    },
  });
};

/**
 * Hook for adding a provider (API key + models)
 */
export const useAddProvider = () => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async ({ provider, apiKey, baseUrl }: ProviderOperation) => {
      if (!apiKey) throw new Error("API key is required");
      return agentApi.setApiKey(provider, apiKey, baseUrl);
    },
    retry: (failureCount, error) => {
      // Don't retry validation errors
      if (error instanceof Error && error.message.includes("API key"))
        return false;
      return failureCount < 1; // Retry once for network errors
    },
    retryDelay: 1000,
    onMutate: async ({ provider, apiKey: _apiKey, baseUrl: _baseUrl }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: providerKeys.apiKeys() });
      await queryClient.cancelQueries({ queryKey: modelKeys.available() });
      await queryClient.cancelQueries({ queryKey: providerKeys.metadata() });

      // Snapshot the previous values
      const previousProviders = queryClient.getQueryData(
        providerKeys.apiKeys()
      );
      const previousModels = queryClient.getQueryData(modelKeys.available());
      const previousMetadata = queryClient.getQueryData(
        providerKeys.metadata()
      );

      // Optimistically add provider to active providers list
      queryClient.setQueryData(
        providerKeys.apiKeys(),
        (old: string[] | undefined) => {
          if (!old) return [provider];
          return old.includes(provider) ? old : [...old, provider];
        }
      );

      // Show immediate success feedback
      showToast(`${provider} added successfully`, "success");

      return { previousProviders, previousModels, previousMetadata };
    },
    onError: (_err, variables, context) => {
      // Rollback all optimistic updates
      if (context?.previousProviders) {
        queryClient.setQueryData(
          providerKeys.apiKeys(),
          context.previousProviders
        );
      }
      if (context?.previousMetadata) {
        queryClient.setQueryData(
          providerKeys.metadata(),
          context.previousMetadata
        );
      }
      if (context?.previousModels) {
        queryClient.setQueryData(modelKeys.available(), context.previousModels);
      }

      // Show error message
      showToast(`Failed to add ${variables.provider}`, "error");
    },
    onSuccess: (_data, _variables) => {
      // Invalidate related queries to ensure server state consistency
      queryClient.invalidateQueries({ queryKey: providerKeys.apiKeys() });
      queryClient.invalidateQueries({ queryKey: modelKeys.available() });
      queryClient.invalidateQueries({ queryKey: providerKeys.metadata() });

      // Dispatch event to notify ModelStatusBar of provider changes
      const event = new CustomEvent("agentConfigUpdated", {
        detail: {
          type: "provider_added",
          timestamp: new Date().toISOString(),
        },
      });
      window.dispatchEvent(event);
    },
  });
};

/**
 * Hook for removing a provider
 */
export const useRemoveProvider = () => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async ({ provider }: ProviderOperation) => {
      return agentApi.removeApiKey(provider);
    },
    retry: (failureCount, _error) => {
      return failureCount < 1; // Retry once for network errors
    },
    retryDelay: 1000,
    onMutate: async ({ provider }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: providerKeys.apiKeys() });
      await queryClient.cancelQueries({ queryKey: modelKeys.available() });
      await queryClient.cancelQueries({ queryKey: providerKeys.metadata() });

      // Snapshot previous caches
      const previousProviders = queryClient.getQueryData(
        providerKeys.apiKeys()
      );
      const previousModels = queryClient.getQueryData(modelKeys.available());
      const previousMetadata = queryClient.getQueryData(
        providerKeys.metadata()
      );

      // Optimistically remove models for this provider
      queryClient.setQueryData(
        modelKeys.available(),
        (old: any[] | undefined) => {
          if (!old) return [];
          return old.filter((model: any) => model.provider !== provider);
        }
      );

      // Optimistically update provider metadata to show as not configured
      queryClient.setQueryData(
        providerKeys.metadata(),
        (old: Record<string, any> | undefined) => {
          if (!old) return {};
          const updated = { ...old };
          if (updated[provider]) {
            updated[provider] = {
              ...updated[provider],
              configured: false,
              status: "not_configured",
            };
          }
          return updated;
        }
      );

      return { previousProviders, previousModels, previousMetadata };
    },
    onError: (_err, variables, context) => {
      // Rollback on error
      if (context?.previousProviders) {
        queryClient.setQueryData(
          providerKeys.apiKeys(),
          context.previousProviders
        );
      }
      if (context?.previousModels) {
        queryClient.setQueryData(modelKeys.available(), context.previousModels);
      }
      if (context?.previousMetadata) {
        queryClient.setQueryData(
          providerKeys.metadata(),
          context.previousMetadata
        );
      }
      showToast(`Failed to remove ${variables.provider}`, "error");
    },
    onSuccess: (_data, variables) => {
      showToast(`${variables.provider} removed successfully`, "success");

      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: modelKeys.available() });
      queryClient.invalidateQueries({ queryKey: providerKeys.metadata() });

      // Dispatch event to notify ModelStatusBar of provider changes
      const event = new CustomEvent("agentConfigUpdated", {
        detail: {
          type: "provider_removed",
          provider: variables.provider,
          timestamp: new Date().toISOString(),
        },
      });
      window.dispatchEvent(event);
    },
  });
};

/**
 * Hook for testing provider API key
 */
export const useTestProvider = () => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async ({ provider }: ProviderOperation) => {
      return agentApi.testApiKey(provider);
    },
    onMutate: async ({ provider }) => {
      // Cancel any outgoing refetches for provider metadata
      await queryClient.cancelQueries({ queryKey: providerKeys.metadata() });

      // Snapshot the previous metadata
      const previousMetadata = queryClient.getQueryData(
        providerKeys.metadata()
      );

      // Optimistically update provider metadata to show testing status
      queryClient.setQueryData(
        providerKeys.metadata(),
        (old: Record<string, any> | undefined) => {
          if (!old)
            return { [provider]: { configured: true, status: "testing" } };
          return {
            ...old,
            [provider]: {
              ...old[provider],
              status: "testing",
              lastTested: new Date().toISOString(),
            },
          };
        }
      );

      // Show immediate feedback
      showToast(`Testing ${provider} connection...`, "info");

      return { previousMetadata };
    },
    onError: (_err, variables, context) => {
      // Rollback to previous metadata
      if (context?.previousMetadata) {
        queryClient.setQueryData(
          providerKeys.metadata(),
          context.previousMetadata
        );
      }

      showToast(`Failed to test ${variables.provider}`, "error");
    },
    onSuccess: (data, variables) => {
      // Update metadata with actual test results
      queryClient.setQueryData(
        providerKeys.metadata(),
        (old: Record<string, any> | undefined) => {
          if (!old)
            return {
              [variables.provider]: {
                configured: data.configured,
                status: data.status,
              },
            };
          return {
            ...old,
            [variables.provider]: {
              ...old[variables.provider],
              configured: data.configured,
              status: data.status,
              lastTested: new Date().toISOString(),
            },
          };
        }
      );

      if (data.configured && data.status === "active") {
        showToast(`${variables.provider} connection successful`, "success");
      } else {
        showToast(`${variables.provider} connection failed`, "error");
      }
    },
  });
};
