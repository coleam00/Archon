import { useMutation, useQueryClient } from "@tanstack/react-query";
import { callAPIWithETag } from "../../shared/api/apiClient";
import { situationService } from "../services/situationService";
import type { RecommendedAction, SituationBrief } from "../types";

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

export function useCreateTaskFromAction() {
  return useMutation<{ task: { id: string } }, Error, { action: RecommendedAction; assignee: string }>({
    mutationFn: ({ action, assignee }) =>
      callAPIWithETag("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: action.title,
          description: `${action.description}\n\nWhy now: ${action.why}`,
          priority: action.priority,
          assignee,
          status: "doing",
        }),
      }),
  });
}
