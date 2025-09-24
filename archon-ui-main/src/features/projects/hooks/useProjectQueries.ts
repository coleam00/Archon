import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createOptimisticEntity,
  type OptimisticEntity,
  removeDuplicateEntities,
  replaceOptimisticEntity,
} from "@/features/shared/optimistic";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "../../shared/queryPatterns";
import { useSmartPolling } from "@/features/shared/hooks";
import { useToast } from "@/features/shared/hooks/useToast";
import { projectService } from "../services";
import type { CreateProjectRequest, Project, UpdateProjectRequest } from "../types";

// Query keys factory for better organization
export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  detail: (id: string) => [...projectKeys.all, "detail", id] as const,
  features: (id: string) => [...projectKeys.all, id, "features"] as const,
  // Documents keys moved to documentKeys in documents feature
  // Tasks keys moved to taskKeys in tasks feature
};

// Fetch all projects with smart polling
export function useProjects() {
  const { refetchInterval } = useSmartPolling(2000); // 2 second base interval for active polling

  return useQuery<Project[]>({
    queryKey: projectKeys.lists(),
    queryFn: () => projectService.listProjects(),
    refetchInterval, // Smart interval based on page visibility/focus
    refetchOnWindowFocus: true, // Refetch immediately when tab gains focus (ETag makes this cheap)
    staleTime: STALE_TIMES.normal,
  });
}

// Fetch project features
export function useProjectFeatures(projectId: string | undefined) {
  // TODO: Phase 4 - Add explicit typing: useQuery<Awaited<ReturnType<typeof projectService.getProjectFeatures>>>
  // See PRPs/local/frontend-state-management-refactor.md Phase 4: Configure Request Deduplication
  return useQuery({
    queryKey: projectId ? projectKeys.features(projectId) : DISABLED_QUERY_KEY,
    queryFn: () => (projectId ? projectService.getProjectFeatures(projectId) : Promise.reject("No project ID")),
    enabled: !!projectId,
    staleTime: STALE_TIMES.normal,
  });
}

// Create project mutation with optimistic updates
export function useCreateProject() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    Awaited<ReturnType<typeof projectService.createProject>>,
    Error,
    CreateProjectRequest,
    { previousProjects?: Project[]; optimisticId: string }
  >({
    mutationFn: (projectData: CreateProjectRequest) => projectService.createProject(projectData),
    onMutate: async (newProjectData) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: projectKeys.lists() });

      // Snapshot the previous value
      const previousProjects = queryClient.getQueryData<Project[]>(projectKeys.lists());

      // Create optimistic project with stable ID
      const optimisticProject = createOptimisticEntity<Project>({
        title: newProjectData.title,
        description: newProjectData.description,
        github_repo: newProjectData.github_repo,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        docs: [],
        features: [],
        prd: undefined,
        data: undefined,
        pinned: false,
      });

      // Optimistically add the new project
      queryClient.setQueryData(projectKeys.lists(), (old: Project[] | undefined) => {
        if (!old) return [optimisticProject];
        // Add new project at the beginning of the list
        return [optimisticProject, ...old];
      });

      return { previousProjects, optimisticId: optimisticProject._localId };
    },
    onError: (error, variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to create project:", error, { variables });

      // Rollback on error
      if (context?.previousProjects) {
        queryClient.setQueryData(projectKeys.lists(), context.previousProjects);
      }

      showToast(`Failed to create project: ${errorMessage}`, "error");
    },
    onSuccess: (response, _variables, context) => {
      // Extract the actual project from the response
      const newProject = response.project;

      // Replace optimistic with server data
      queryClient.setQueryData(projectKeys.lists(), (projects: (Project & Partial<OptimisticEntity>)[] = []) => {
        const replaced = replaceOptimisticEntity(projects, context?.optimisticId || "", newProject);
        return removeDuplicateEntities(replaced);
      });

      showToast("Project created successfully!", "success");
    },
    onSettled: () => {
      // Always refetch to ensure consistency after operation completes
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}

// Update project mutation (for pinning, etc.)
export function useUpdateProject() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: ({ projectId, updates }: { projectId: string; updates: UpdateProjectRequest }) =>
      projectService.updateProject(projectId, updates),
    onMutate: async ({ projectId, updates }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: projectKeys.lists() });

      // Snapshot the previous value
      const previousProjects = queryClient.getQueryData<Project[]>(projectKeys.lists());

      // Optimistically update
      queryClient.setQueryData(projectKeys.lists(), (old: Project[] | undefined) => {
        if (!old) return old;

        // If pinning a project, unpin all others first
        if (updates.pinned === true) {
          return old.map((p) => ({
            ...p,
            pinned: p.id === projectId,
          }));
        }

        return old.map((p) => (p.id === projectId ? { ...p, ...updates } : p));
      });

      return { previousProjects };
    },
    onError: (_err, _variables, context) => {
      // Rollback on error
      if (context?.previousProjects) {
        queryClient.setQueryData(projectKeys.lists(), context.previousProjects);
      }
      showToast("Failed to update project", "error");
    },
    onSuccess: (data, variables) => {
      // Invalidate and refetch
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });

      if (variables.updates.pinned !== undefined) {
        const message = variables.updates.pinned
          ? `Pinned "${data.title}" as default project`
          : `Removed "${data.title}" from default selection`;
        showToast(message, "info");
      }
    },
  });
}

// Delete project mutation with optimistic updates
export function useDeleteProject() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (projectId: string) => projectService.deleteProject(projectId),
    onMutate: async (projectId) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: projectKeys.lists() });

      // Snapshot the previous value
      const previousProjects = queryClient.getQueryData<Project[]>(projectKeys.lists());

      // Optimistically remove the project
      queryClient.setQueryData(projectKeys.lists(), (old: Project[] | undefined) => {
        if (!old) return old;
        return old.filter((project) => project.id !== projectId);
      });

      return { previousProjects };
    },
    onError: (error, projectId, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to delete project:", error, { projectId });

      // Rollback on error
      if (context?.previousProjects) {
        queryClient.setQueryData(projectKeys.lists(), context.previousProjects);
      }

      showToast(`Failed to delete project: ${errorMessage}`, "error");
    },
    onSuccess: (_, projectId) => {
      // Don't refetch on success - trust optimistic update
      // Only remove the specific project's detail data (including nested keys)
      queryClient.removeQueries({ queryKey: projectKeys.detail(projectId), exact: false });
      showToast("Project deleted successfully", "success");
    },
  });
}
