import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createOptimisticEntity, replaceOptimisticEntity } from "@/features/shared/utils/optimistic";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "../../../shared/config/queryPatterns";
import { useToast } from "../../../shared/hooks/useToast";
import { sprintService } from "../services";
import type { CreateSprintRequest, Sprint, UpdateSprintRequest } from "../types";

export const sprintKeys = {
  all: ["sprints"] as const,
  byProject: (projectId: string) => ["projects", projectId, "sprints"] as const,
  detail: (id: string) => [...sprintKeys.all, "detail", id] as const,
};

export function useProjectSprints(projectId: string | undefined) {
  return useQuery<Sprint[]>({
    queryKey: projectId ? sprintKeys.byProject(projectId) : DISABLED_QUERY_KEY,
    queryFn: () => {
      if (!projectId) throw new Error("No project ID");
      return sprintService.listSprints(projectId);
    },
    enabled: !!projectId,
    staleTime: STALE_TIMES.normal,
  });
}

export function useCreateSprint() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<Sprint, Error, CreateSprintRequest, { previousSprints?: Sprint[]; optimisticId: string }>({
    mutationFn: (data: CreateSprintRequest) => sprintService.createSprint(data),

    onMutate: async (newData) => {
      await queryClient.cancelQueries({ queryKey: sprintKeys.byProject(newData.project_id) });
      const previousSprints = queryClient.getQueryData<Sprint[]>(sprintKeys.byProject(newData.project_id));

      const optimisticSprint = createOptimisticEntity<Sprint>({
        project_id: newData.project_id,
        name: newData.name,
        goal: newData.goal,
        status: newData.status ?? "planning",
        start_date: newData.start_date,
        end_date: newData.end_date,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      queryClient.setQueryData(sprintKeys.byProject(newData.project_id), (old: Sprint[] | undefined) =>
        old ? [...old, optimisticSprint] : [optimisticSprint],
      );

      return { previousSprints, optimisticId: optimisticSprint._localId };
    },

    onError: (error, variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (context?.previousSprints) {
        queryClient.setQueryData(sprintKeys.byProject(variables.project_id), context.previousSprints);
      }
      showToast(`Failed to create sprint: ${errorMessage}`, "error");
    },

    onSuccess: (serverSprint, variables, context) => {
      queryClient.setQueryData(sprintKeys.byProject(variables.project_id), (old: Sprint[] | undefined) => {
        if (!old) return [serverSprint];
        return replaceOptimisticEntity(old, context?.optimisticId ?? "", serverSprint);
      });
      showToast("Sprint created", "success");
    },

    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: sprintKeys.byProject(variables.project_id) });
    },
  });
}

export function useUpdateSprint(projectId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    Sprint,
    Error,
    { sprintId: string; updates: UpdateSprintRequest },
    { previousSprints?: Sprint[] }
  >({
    mutationFn: ({ sprintId, updates }) => sprintService.updateSprint(sprintId, updates),

    onMutate: async ({ sprintId, updates }) => {
      await queryClient.cancelQueries({ queryKey: sprintKeys.byProject(projectId) });
      const previousSprints = queryClient.getQueryData<Sprint[]>(sprintKeys.byProject(projectId));

      queryClient.setQueryData<Sprint[]>(sprintKeys.byProject(projectId), (old) =>
        old ? old.map((s) => (s.id === sprintId ? { ...s, ...updates } : s)) : old,
      );

      return { previousSprints };
    },

    onError: (error, _variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (context?.previousSprints) {
        queryClient.setQueryData(sprintKeys.byProject(projectId), context.previousSprints);
      }
      showToast(`Failed to update sprint: ${errorMessage}`, "error");
    },

    onSuccess: (data) => {
      queryClient.setQueryData<Sprint[]>(sprintKeys.byProject(projectId), (old) =>
        old ? old.map((s) => (s.id === data.id ? data : s)) : old,
      );
      showToast("Sprint updated", "success");
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sprintKeys.byProject(projectId) });
    },
  });
}

export function useDeleteSprint(projectId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<void, Error, string, { previousSprints?: Sprint[] }>({
    mutationFn: (sprintId: string) => sprintService.deleteSprint(sprintId),

    onMutate: async (sprintId) => {
      await queryClient.cancelQueries({ queryKey: sprintKeys.byProject(projectId) });
      const previousSprints = queryClient.getQueryData<Sprint[]>(sprintKeys.byProject(projectId));

      queryClient.setQueryData<Sprint[]>(sprintKeys.byProject(projectId), (old) =>
        old ? old.filter((s) => s.id !== sprintId) : old,
      );

      return { previousSprints };
    },

    onError: (error, _sprintId, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (context?.previousSprints) {
        queryClient.setQueryData(sprintKeys.byProject(projectId), context.previousSprints);
      }
      showToast(`Failed to delete sprint: ${errorMessage}`, "error");
    },

    onSuccess: () => {
      showToast("Sprint deleted", "success");
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sprintKeys.byProject(projectId) });
    },
  });
}
