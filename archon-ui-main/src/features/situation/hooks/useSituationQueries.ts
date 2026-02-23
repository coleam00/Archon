import { useMutation, useQueryClient } from "@tanstack/react-query";
import { situationService } from "../services/situationService";
import type { SituationBrief } from "../types";

export const situationKeys = {
  all: ["situation"] as const,
  latest: () => [...situationKeys.all, "latest"] as const,
};

export function useAnalyzeSituation() {
  const queryClient = useQueryClient();
  return useMutation<SituationBrief, Error>({
    mutationFn: () => situationService.analyze(),
    onSuccess: (data) => {
      queryClient.setQueryData(situationKeys.latest(), data);
    },
  });
}
