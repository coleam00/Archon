import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSmartPolling } from "@/features/shared/hooks";
import { useToast } from "@/features/shared/hooks/useToast";
import {
  createOptimisticEntity,
  type OptimisticEntity,
  removeDuplicateEntities,
  replaceOptimisticEntity,
} from "@/features/shared/utils/optimistic";
import { STALE_TIMES } from "../../../shared/config/queryPatterns";
import { ollamaService } from "../services/ollamaService";
import type { OllamaInstance, ConnectionTestResult, OllamaModel } from "../types";

export const ollamaKeys = {
  all: ["ollama"] as const,
  instances: () => [...ollamaKeys.all, "instances"] as const,
  models: (instanceId: string) => [...ollamaKeys.all, "models", instanceId] as const,
  health: (instanceId: string) => [...ollamaKeys.all, "health", instanceId] as const,
};

export function useInstances() {
  const { refetchInterval } = useSmartPolling(5000);

  return useQuery<OllamaInstance[]>({
    queryKey: ollamaKeys.instances(),
    queryFn: () => ollamaService.listInstances(),
    refetchInterval,
    staleTime: STALE_TIMES.normal,
  });
}

export function useCreateInstance() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    OllamaInstance,
    Error,
    Omit<OllamaInstance, 'id'>,
    { previousInstances?: OllamaInstance[]; optimisticId: string }
  >({
    mutationFn: (instanceData) => ollamaService.createInstance(instanceData),
    onMutate: async (newInstanceData) => {
      await queryClient.cancelQueries({ queryKey: ollamaKeys.instances() });

      const previousInstances = queryClient.getQueryData<OllamaInstance[]>(ollamaKeys.instances());

      const optimisticInstance = createOptimisticEntity<OllamaInstance>({
        ...newInstanceData,
        id: '',
      });

      queryClient.setQueryData(ollamaKeys.instances(), (old: OllamaInstance[] | undefined) => {
        if (!old) return [optimisticInstance];
        return [optimisticInstance, ...old];
      });

      return { previousInstances, optimisticId: optimisticInstance._localId };
    },
    onError: (error, _variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (context?.previousInstances) {
        queryClient.setQueryData(ollamaKeys.instances(), context.previousInstances);
      }

      showToast(`Failed to create instance: ${errorMessage}`, "error");
    },
    onSuccess: (response, _variables, context) => {
      queryClient.setQueryData(ollamaKeys.instances(), (instances: (OllamaInstance & Partial<OptimisticEntity>)[] = []) => {
        const replaced = replaceOptimisticEntity(instances, context?.optimisticId || "", response);
        return removeDuplicateEntities(replaced);
      });

      showToast("Instance created successfully!", "success");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ollamaKeys.instances() });
    },
  });
}

export function useUpdateInstance() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<OllamaInstance> }) =>
      ollamaService.updateInstance(id, updates),
    onMutate: async ({ id, updates }) => {
      await queryClient.cancelQueries({ queryKey: ollamaKeys.instances() });

      const previousInstances = queryClient.getQueryData<OllamaInstance[]>(ollamaKeys.instances());

      queryClient.setQueryData(ollamaKeys.instances(), (old: OllamaInstance[] | undefined) => {
        if (!old) return old;
        return old.map((inst) => (inst.id === id ? { ...inst, ...updates } : inst));
      });

      return { previousInstances };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousInstances) {
        queryClient.setQueryData(ollamaKeys.instances(), context.previousInstances);
      }
      showToast("Failed to update instance", "error");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ollamaKeys.instances() });
      showToast("Instance updated successfully", "success");
    },
  });
}

export function useDeleteInstance() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (instanceId: string) => ollamaService.deleteInstance(instanceId),
    onMutate: async (instanceId) => {
      await queryClient.cancelQueries({ queryKey: ollamaKeys.instances() });

      const previousInstances = queryClient.getQueryData<OllamaInstance[]>(ollamaKeys.instances());

      queryClient.setQueryData(ollamaKeys.instances(), (old: OllamaInstance[] | undefined) => {
        if (!old) return old;
        return old.filter((inst) => inst.id !== instanceId);
      });

      return { previousInstances };
    },
    onError: (error, _instanceId, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (context?.previousInstances) {
        queryClient.setQueryData(ollamaKeys.instances(), context.previousInstances);
      }

      showToast(`Failed to delete instance: ${errorMessage}`, "error");
    },
    onSuccess: () => {
      showToast("Instance deleted successfully", "success");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ollamaKeys.instances() });
    },
  });
}

export function useTestConnection() {
  const { showToast } = useToast();

  return useMutation<ConnectionTestResult, Error, string>({
    mutationFn: (baseUrl: string) => ollamaService.testConnection(baseUrl),
    onSuccess: (result) => {
      if (result.isHealthy) {
        showToast(`Connection successful (${result.responseTimeMs}ms)`, "success");
      } else {
        showToast(result.error || "Connection failed", "error");
      }
    },
    onError: (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showToast(`Connection test failed: ${errorMessage}`, "error");
    },
  });
}

export function useSetModel() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: ({ instanceId, modelType }: { instanceId: string; modelType: 'chat' | 'embedding' }) =>
      ollamaService.setModel(instanceId, modelType),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ollamaKeys.instances() });
      const modelTypeLabel = variables.modelType === 'chat' ? 'Chat' : 'Embedding';
      showToast(`${modelTypeLabel} model set successfully`, "success");
    },
    onError: (error, variables) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const modelTypeLabel = variables.modelType === 'chat' ? 'chat' : 'embedding';
      showToast(`Failed to set ${modelTypeLabel} model: ${errorMessage}`, "error");
    },
  });
}
