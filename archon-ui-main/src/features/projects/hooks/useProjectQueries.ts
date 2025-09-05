import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSmartPolling } from "../../ui/hooks";
import { useToast } from "../../ui/hooks/useToast";
import { projectService, taskService } from "../services";
import type { CreateProjectRequest, Project, UpdateProjectRequest } from "../types";

// Query keys factory for better organization
export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  list: (filters?: unknown) => [...projectKeys.lists(), filters] as const,
  details: () => [...projectKeys.all, "detail"] as const,
  detail: (id: string) => [...projectKeys.details(), id] as const,
  tasks: (projectId: string) => [...projectKeys.detail(projectId), "tasks"] as const,
  taskCounts: () => ["taskCounts"] as const,
  features: (projectId: string) => [...projectKeys.detail(projectId), "features"] as const,
  documents: (projectId: string) => [...projectKeys.detail(projectId), "documents"] as const,
};

// Fetch all projects with smart polling
export function useProjects() {
  const { refetchInterval } = useSmartPolling(20000); // 20 second base interval for projects

  return useQuery<Project[]>({
    queryKey: projectKeys.lists(),
    queryFn: () => projectService.listProjects(),
    refetchInterval, // Smart interval based on page visibility/focus
    refetchOnWindowFocus: true, // Refetch immediately when tab gains focus (ETag makes this cheap)
    staleTime: 15000, // Consider data stale after 15 seconds
  });
}

// Fetch task counts for all projects
export function useTaskCounts() {
  return useQuery<Awaited<ReturnType<typeof taskService.getTaskCountsForAllProjects>>>({
    queryKey: projectKeys.taskCounts(),
    queryFn: () => taskService.getTaskCountsForAllProjects(),
    refetchInterval: false, // Don't poll, only refetch manually
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
}

// Fetch project features
export function useProjectFeatures(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? projectKeys.features(projectId) : ["features-undefined"],
    queryFn: () => (projectId ? projectService.getProjectFeatures(projectId) : Promise.reject("No project ID")),
    enabled: !!projectId,
    staleTime: 30000, // Cache for 30 seconds
  });
}

// Create project mutation with optimistic updates
export function useCreateProject() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (projectData: CreateProjectRequest) => projectService.createProject(projectData),
    onMutate: async (newProjectData) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: projectKeys.lists() });

      // Snapshot the previous value
      const previousProjects = queryClient.getQueryData<Project[]>(projectKeys.lists());

      // Create optimistic project with temporary ID
      const tempId = `temp-${Date.now()}`;
      const optimisticProject: Project = {
        id: tempId, // Temporary ID until real one comes back
        title: newProjectData.title,
        description: newProjectData.description,
        github_repo: newProjectData.github_repo,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        prd: undefined,
        features: [],
        data: undefined,
        docs: [],
        pinned: false,
      };

      // Optimistically add the new project
      queryClient.setQueryData(projectKeys.lists(), (old: Project[] | undefined) => {
        if (!old) return [optimisticProject];
        // Add new project at the beginning of the list
        return [optimisticProject, ...old];
      });

      return { previousProjects, tempId };
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

      // Replace optimistic project with real one from server
      queryClient.setQueryData(projectKeys.lists(), (old: Project[] | undefined) => {
        if (!old) return [newProject];
        // Replace only the specific temp project with real one
        return old
          .map((project) => (project.id === context?.tempId ? newProject : project))
          .filter(
            (project, index, self) =>
              // Remove any duplicates just in case
              index === self.findIndex((p) => p.id === project.id),
          );
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
