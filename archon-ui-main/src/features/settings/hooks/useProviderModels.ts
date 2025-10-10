import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/features/shared/hooks/useToast";
import { STALE_TIMES } from "../../shared/config/queryPatterns";
import { providerModelsService, type ProviderKey, type ProviderModelMap } from "../services/providerModelsService";

export const providerModelsKeys = {
  all: ["providerModels"] as const,
  list: () => [...providerModelsKeys.all, "list"] as const,
};

export function useProviderModels() {
  return useQuery<ProviderModelMap>({
    queryKey: providerModelsKeys.list(),
    queryFn: () => providerModelsService.loadProviderModels(),
    staleTime: STALE_TIMES.rare,
  });
}

export function useSetProviderModel() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: ({
      provider,
      modelType,
      modelName,
      ollamaHostUrl
    }: {
      provider: ProviderKey;
      modelType: 'chat' | 'embedding';
      modelName: string;
      ollamaHostUrl?: string;
    }) => providerModelsService.saveProviderModel(provider, modelType, modelName, ollamaHostUrl),

    onMutate: async ({ provider, modelType, modelName }) => {
      await queryClient.cancelQueries({ queryKey: providerModelsKeys.list() });

      const previousModels = queryClient.getQueryData<ProviderModelMap>(providerModelsKeys.list());

      queryClient.setQueryData(providerModelsKeys.list(), (old: ProviderModelMap | undefined) => {
        if (!old) return old;

        return {
          ...old,
          [provider]: {
            ...old[provider],
            [modelType === 'chat' ? 'chatModel' : 'embeddingModel']: modelName
          }
        };
      });

      return { previousModels };
    },

    onError: (_err, _variables, context) => {
      if (context?.previousModels) {
        queryClient.setQueryData(providerModelsKeys.list(), context.previousModels);
      }
      showToast("Failed to save model selection", "error");
    },

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerModelsKeys.list() });
      showToast("Model settings saved successfully!", "success");
    },
  });
}
