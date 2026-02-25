import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/features/shared/hooks/useToast";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "../../shared/config/queryPatterns";
import { sprintService } from "../services/sprintService";
import type { CreateSprintRequest, UpdateSprintRequest } from "../types";

export const sprintKeys = {
  all: ["sprints"] as const,
  lists: () => [...sprintKeys.all, "list"] as const,
  byProject: (projectId: string) => ["sprints", "project", projectId] as const,
  detail: (id: string) => ["sprints", "detail", id] as const,
};

export function useProjectSprints(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? sprintKeys.byProject(projectId) : DISABLED_QUERY_KEY,
    queryFn: () => (projectId ? sprintService.listSprints(projectId) : Promise.reject("No project ID")),
    enabled: !!projectId,
    staleTime: STALE_TIMES.normal,
  });
}

export function useSprint(sprintId: string | undefined) {
  return useQuery({
    queryKey: sprintId ? sprintKeys.detail(sprintId) : DISABLED_QUERY_KEY,
    queryFn: () => (sprintId ? sprintService.getSprint(sprintId) : Promise.reject("No sprint ID")),
    enabled: !!sprintId,
    staleTime: STALE_TIMES.normal,
  });
}

export function useCreateSprint() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (data: CreateSprintRequest) => sprintService.createSprint(data),
    onSuccess: (sprint) => {
      queryClient.invalidateQueries({ queryKey: sprintKeys.byProject(sprint.project_id) });
      showToast("Sprint created successfully", "success");
    },
    onError: (error) => {
      console.error("Failed to create sprint:", error);
      showToast("Failed to create sprint", "error");
    },
  });
}

export function useUpdateSprint(projectId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: ({ sprintId, data }: { sprintId: string; data: UpdateSprintRequest }) =>
      sprintService.updateSprint(sprintId, data),
    onSuccess: (sprint) => {
      queryClient.invalidateQueries({ queryKey: sprintKeys.byProject(projectId) });
      queryClient.invalidateQueries({ queryKey: sprintKeys.detail(sprint.id) });
      showToast("Sprint updated successfully", "success");
    },
    onError: (error, { sprintId }) => {
      console.error("Failed to update sprint:", { sprintId, error });
      showToast("Failed to update sprint", "error");
    },
  });
}

export function useDeleteSprint(projectId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (sprintId: string) => sprintService.deleteSprint(sprintId),
    onSuccess: (_, sprintId) => {
      queryClient.invalidateQueries({ queryKey: sprintKeys.byProject(projectId) });
      queryClient.invalidateQueries({ queryKey: sprintKeys.detail(sprintId) });
      showToast("Sprint deleted successfully", "success");
    },
    onError: (error, sprintId) => {
      console.error("Failed to delete sprint:", { sprintId, error });
      showToast("Failed to delete sprint", "error");
    },
  });
}
